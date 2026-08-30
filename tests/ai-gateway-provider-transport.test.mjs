import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createPinnedProviderTransport } from "../lib/ai-gateway-provider-transport.ts";

const policy = {
  async assertAllowed(endpoint) {
    return { endpoint,hostname: "provider.example",pinnedAddresses: ["93.184.216.34"] };
  },
};

function fakeRequest(factory) {
  let calls = 0;
  return {
    request(options,callback) {
      calls += 1;
      const request = new EventEmitter();
      request.setTimeout = (_milliseconds,onTimeout) => { request.onTimeout = onTimeout; };
      request.write = () => undefined;
      request.end = () => factory({ options,callback,request });
      request.destroy = (error) => queueMicrotask(() => request.emit("error",error));
      return request;
    },
    calls: () => calls,
  };
}

function response(statusCode,chunks = []) {
  const value = new EventEmitter();
  value.statusCode = statusCode;
  value.headers = {};
  queueMicrotask(() => {
    for (const chunk of chunks) value.emit("data",Buffer.from(chunk));
    value.emit("end");
  });
  return value;
}

test("pinned Provider transport returns redirects without following them", async () => {
  const fake = fakeRequest(({ callback }) => callback(response(302,["{}"])));
  const transport = createPinnedProviderTransport({ endpointPolicy: policy,requestImpl: fake.request });
  const result = await transport({ method: "GET",url: "https://provider.example/v1/models",headers: {} });
  assert.equal(result.status,302);
  assert.equal(fake.calls(),1);
});

test("pinned Provider transport produces safe timeout and response-size failures", async () => {
  const timeoutFake = fakeRequest(({ request }) => request.onTimeout());
  const timed = createPinnedProviderTransport({ endpointPolicy: policy,requestImpl: timeoutFake.request,timeoutMs: 1_000 });
  await assert.rejects(
    timed({ method: "GET",url: "https://provider.example/v1/models",headers: {} }),
    (error) => error?.code === "timeout",
  );

  const largeFake = fakeRequest(({ callback }) => callback(response(200,["123456789"]))) ;
  const bounded = createPinnedProviderTransport({ endpointPolicy: policy,requestImpl: largeFake.request,maximumResponseBytes: 8 });
  await assert.rejects(
    bounded({ method: "GET",url: "https://provider.example/v1/models",headers: {} }),
    (error) => error?.code === "validation",
  );
});

test("pinned Provider transport preserves user cancellation as a terminal failure", async () => {
  const controller = new AbortController();
  const abortedFake = fakeRequest(({ request }) => {
    controller.abort();
    request.destroy(new DOMException("cancelled", "AbortError"));
  });
  const transport = createPinnedProviderTransport({ endpointPolicy: policy,requestImpl: abortedFake.request });
  await assert.rejects(
    transport({
      method: "GET",
      url: "https://provider.example/v1/models",
      headers: {},
      signal: controller.signal,
    }),
    (error) => error?.code === "cancelled",
  );
});
