import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

import type { ProviderTransport } from "@agentnovas/ai-control-plane";

import type { createPublicHttpsEndpointPolicy } from "./ai-gateway-endpoint-policy.ts";

type Policy = ReturnType<typeof createPublicHttpsEndpointPolicy>;

function transportFailure(code: string) {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

export function createPinnedProviderTransport(options: {
  endpointPolicy: Policy;
  requestImpl?: typeof httpsRequest;
  timeoutMs?: number;
  maximumRequestBytes?: number;
  maximumResponseBytes?: number;
}): ProviderTransport {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000,1_000),120_000);
  const maximumRequestBytes = Math.min(options.maximumRequestBytes ?? 1_048_576,4_194_304);
  const maximumResponseBytes = Math.min(options.maximumResponseBytes ?? 2_097_152,8_388_608);
  return async request => {
    const allowed = await options.endpointPolicy.assertAllowed(request.url);
    const target = new URL(allowed.endpoint);
    const body = request.body === undefined ? null : Buffer.from(JSON.stringify(request.body));
    if (body && body.byteLength > maximumRequestBytes) throw transportFailure("validation");
    return new Promise((resolveRequest,rejectRequest) => {
      let settled = false;
      const finishError = (error: unknown) => {
        if (settled) return;
        settled = true;
        rejectRequest(error);
      };
      const providerRequest = (options.requestImpl ?? httpsRequest)({
        protocol: "https:",
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: {
          ...request.headers,
          ...(body ? { "content-length": String(body.byteLength) } : {}),
        },
        servername: target.hostname,
        lookup(_hostname,_lookupOptions,callback) {
          const address = allowed.pinnedAddresses[0];
          callback(null,address,isIP(address));
        },
        signal: request.signal,
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data",chunk => {
          size += chunk.length;
          if (size > maximumResponseBytes) {
            const error = transportFailure("validation");
            finishError(error);
            providerRequest.destroy(error);
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end",() => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = {};
          if (text) {
            try { parsed = JSON.parse(text); } catch { parsed = {}; }
          }
          resolveRequest({
            status: response.statusCode ?? 502,
            headers: Object.fromEntries(Object.entries(response.headers).map(([key,value]) => [
              key,Array.isArray(value) ? value.join(",") : value,
            ])),
            body: parsed,
          });
        });
      });
      providerRequest.setTimeout(timeoutMs,() => providerRequest.destroy(transportFailure("timeout")));
      providerRequest.on("error",error => finishError(error));
      if (body) providerRequest.write(body);
      providerRequest.end();
    });
  };
}
