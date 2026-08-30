import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { createOpenAiCompatibleAdapter } from "@agentnovas/ai-control-plane";

import { createAgentNovasAiGateway } from "../lib/agentnovas-ai-gateway.ts";
import { createPublicHttpsEndpointPolicy } from "../lib/ai-gateway-endpoint-policy.ts";
import { createPinnedProviderTransport } from "../lib/ai-gateway-provider-transport.ts";
import { createManagedAiSecretStore } from "../lib/managed-ai-secret-store.ts";
import { getAiGatewayPostgresPool } from "../lib/postgres.ts";

if (process.env.AI_GATEWAY_ENABLED !== "true") {
  process.stdout.write("AI Gateway is disabled.\n");
  process.exit(0);
}

const sharedSecret = process.env.AI_GATEWAY_SHARED_SECRET?.trim() ?? "";
if (sharedSecret.length < 32) throw new Error("AI_GATEWAY_SHARED_SECRET must contain at least 32 characters");
const managedDirectory = process.env.AI_MANAGED_SECRET_DIRECTORY?.trim() ?? "";
const port = Math.min(Math.max(Number(process.env.AI_GATEWAY_PORT) || 3030,1_024),65_535);
const maximumConcurrent = Math.min(Math.max(Number(process.env.AI_GATEWAY_MAX_CONCURRENT) || 8,1),64);
const maximumPerMinute = Math.min(Math.max(Number(process.env.AI_GATEWAY_MAX_PER_MINUTE) || 120,1),10_000);
const activeControllers = new Map();
const recentRequests = [];
let activeCount = 0;

const pool = await getAiGatewayPostgresPool();
const providerAdapter = createOpenAiCompatibleAdapter({
  transport: createPinnedProviderTransport({ endpointPolicy: createPublicHttpsEndpointPolicy() }),
});
const gateway = createAgentNovasAiGateway({
  pool,
  secretStore: createManagedAiSecretStore(managedDirectory),
  providerAdapter,
});

function authorized(request) {
  const expected = Buffer.from(`Bearer ${sharedSecret}`);
  const actual = Buffer.from(String(request.headers.authorization ?? ""));
  return expected.length === actual.length && timingSafeEqual(expected,actual);
}

function json(response,status,body) {
  response.writeHead(status,{ "content-type": "application/json; charset=utf-8","cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function requestJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_048_576) throw Object.assign(new Error("AI_REQUEST_TOO_LARGE"),{ status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("AI_REQUEST_INVALID"),{ status: 400 }); }
}

function admitted() {
  const cutoff = Date.now() - 60_000;
  while (recentRequests.length && recentRequests[0] < cutoff) recentRequests.shift();
  if (activeCount >= maximumConcurrent || recentRequests.length >= maximumPerMinute) return false;
  recentRequests.push(Date.now());
  activeCount += 1;
  return true;
}

const server = createServer(async (request,response) => {
  if (request.url === "/health" && request.method === "GET") {
    json(response,200,{ ok: true,enabled: true });
    return;
  }
  if (!authorized(request)) {
    json(response,401,{ error: { code: "AI_GATEWAY_UNAUTHORIZED" } });
    return;
  }
  const cancelMatch = request.url?.match(/^\/v1\/invocations\/([A-Za-z0-9._:-]{1,160})\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const controller = activeControllers.get(cancelMatch[1]);
    if (controller) controller.abort();
    json(response,200,{ cancelled: Boolean(controller) });
    return;
  }
  if (request.url !== "/v1/invoke" || request.method !== "POST") {
    json(response,404,{ error: { code: "AI_GATEWAY_ROUTE_NOT_FOUND" } });
    return;
  }
  if (!admitted()) {
    json(response,429,{ error: { code: "AI_GATEWAY_LIMITED" } });
    return;
  }
  try {
    const body = await requestJson(request);
    const invocationId = String(body.invocationId ?? "");
    const controller = new AbortController();
    activeControllers.set(invocationId,controller);
    try {
      const result = await gateway.invoke({
        invocationId,
        requestHash: String(body.requestHash ?? ""),
        roleKey: String(body.roleKey ?? ""),
        operation: String(body.operation ?? ""),
        trafficKind: body.trafficKind === "probe" ? "probe" : "business",
        payload: body.payload,
        signal: controller.signal,
      });
      if (body.stream === true || request.headers.accept === "text/event-stream") {
        response.writeHead(200,{
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.write(`event: content\ndata: ${JSON.stringify({ content: result.content })}\n\n`);
        response.end(`event: receipt\ndata: ${JSON.stringify(result.receipt)}\n\n`);
      } else {
        json(response,200,result);
      }
    } finally {
      activeControllers.delete(invocationId);
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "AI_GATEWAY_FAILED";
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
    json(response,Number.isInteger(status) ? status : 500,{
      error: { code,incidentId: createHash("sha256").update(`${Date.now()}:${crypto.randomUUID()}`).digest("hex").slice(0,16) },
    });
  } finally {
    activeCount -= 1;
  }
});

server.listen(port,"127.0.0.1",() => {
  process.stdout.write(`AI Gateway listening on 127.0.0.1:${port}.\n`);
});

async function stop() {
  for (const controller of activeControllers.values()) controller.abort();
  server.close();
  await pool.end();
}
process.on("SIGTERM",stop);
process.on("SIGINT",stop);
