import assert from "node:assert/strict";
import test from "node:test";

import { probeLlmProvider } from "../lib/llm-model-catalog.ts";
import { normalizeLlmModelsEndpoint } from "../lib/llm-endpoint.ts";
import { LLM_PROVIDER_PRESETS, findLlmProviderPreset } from "../lib/llm-provider-presets.ts";

// 全部用注入的 fetch 与 DNS 解析。不发真实请求。
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

function stub(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return handler(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });

test("模型列表端点由 base_url 推出", () => {
  assert.equal(normalizeLlmModelsEndpoint("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
  // 运维填了完整补全路径时，列表在同级而不是它的子路径。
  assert.equal(
    normalizeLlmModelsEndpoint("https://api.openai.com/v1/chat/completions"),
    "https://api.openai.com/v1/models",
  );
  assert.equal(normalizeLlmModelsEndpoint("https://x.com/v1/responses"), "https://x.com/v1/models");
});

test("拉取并排序去重模型列表", async () => {
  const fetchImpl = stub(() => ok({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "gpt-4o" }] }));
  const result = await probeLlmProvider({
    baseUrl: "https://api.openai.com/v1", apiKey: "sk-test",
    fetchImpl, resolver: publicResolver,
  });
  assert.deepEqual(result.models, ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(result.modelsUnavailableReason, null);
  assert.equal(result.completion, null, "没指定模型就不做补全调用");
});

test("指定模型时顺带做一次真实补全调用", async () => {
  const fetchImpl = stub((url) => url.endsWith("/models")
    ? ok({ data: [{ id: "deepseek-chat" }] })
    : ok({ choices: [{ message: { content: "OK" } }] }));
  const result = await probeLlmProvider({
    baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-test", modelName: "deepseek-chat",
    fetchImpl, resolver: publicResolver,
  });
  assert.equal(result.completion.ok, true);
  assert.equal(result.completion.apiStyle, "chat_completions");
  assert.equal(fetchImpl.calls[1].url, "https://api.deepseek.com/v1/chat/completions");
});

test("拉不到模型列表但补全可用，仍算成功", async () => {
  // 有些中转站和自建网关不实现 /models，但补全接口是好的。
  // 把它当成硬错误会挡住一批完全可用的配置。
  const fetchImpl = stub((url) => url.endsWith("/models") ? fail(404) : ok({ choices: [] }));
  const result = await probeLlmProvider({
    baseUrl: "https://relay.example.com/v1", apiKey: "sk-test", modelName: "some-model",
    fetchImpl, resolver: publicResolver,
  });
  assert.equal(result.ok, true);
  assert.equal(result.models, null);
  assert.match(result.modelsUnavailableReason, /接口路径不存在/);
  assert.equal(result.completion.ok, true, "补全可用才是关键");
});

test("两条都不通才算失败", async () => {
  const fetchImpl = stub(() => fail(401));
  await assert.rejects(
    () => probeLlmProvider({
      baseUrl: "https://api.openai.com/v1", apiKey: "bad", fetchImpl, resolver: publicResolver,
    }),
    /API Key 无效或没有权限/,
  );
});

test("错误信息说明该改哪里，不只给状态码", async () => {
  // 裸 status 码要人去查文档。404 最常见的原因就是 /v1 多写或少写。
  const fetchImpl = stub(() => fail(404));
  await assert.rejects(
    () => probeLlmProvider({ baseUrl: "https://x.example.com/v1", apiKey: "k", fetchImpl, resolver: publicResolver }),
    /base_url 是否少了或多了/,
  );
});

test("模型可用但 Key 无权时，补全失败要抛出来", async () => {
  const fetchImpl = stub((url) => url.endsWith("/models") ? ok({ data: [{ id: "m" }] }) : fail(403));
  await assert.rejects(
    () => probeLlmProvider({
      baseUrl: "https://x.example.com/v1", apiKey: "k", modelName: "m",
      fetchImpl, resolver: publicResolver,
    }),
    /API Key 无效或没有权限/,
  );
});

test("内网地址被拒绝——SSRF 防护对模型列表同样生效", async () => {
  await assert.rejects(
    () => probeLlmProvider({
      baseUrl: "https://127.0.0.1/v1", apiKey: "k",
      fetchImpl: stub(() => ok({ data: [] })), resolver: publicResolver,
    }),
    /本机或内网地址|无法获取模型列表/,
  );
});

test("预设只是填表模板，含自定义项", () => {
  const ids = LLM_PROVIDER_PRESETS.map((p) => p.id);
  assert.ok(ids.includes("openrouter"), "应包含 OpenRouter");
  assert.ok(ids.includes("custom"), "必须保留自定义——预设不是白名单");
  assert.equal(findLlmProviderPreset("custom").baseUrl, "", "自定义不预填地址");
  // 每个预设都要有说明：路径差异正是运维最容易填错的地方。
  for (const preset of LLM_PROVIDER_PRESETS) {
    assert.ok(preset.note.length > 5, `${preset.id} 缺少说明`);
  }
});

test("预设地址全部是 HTTPS 且不含查询参数", () => {
  for (const preset of LLM_PROVIDER_PRESETS.filter((p) => p.baseUrl)) {
    const url = new URL(preset.baseUrl);
    assert.equal(url.protocol, "https:", `${preset.id} 必须是 HTTPS`);
    assert.equal(url.search, "", `${preset.id} 不应带查询参数`);
  }
});
