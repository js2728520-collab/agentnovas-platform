import assert from "node:assert/strict";
import test from "node:test";

import {
  callRuntimeExplanationAgent,
  resolveRuntimeExplanationPrompt,
  validateRuntimeExplanationOutput,
} from "../lib/runtime-explanations.ts";

const config = {
  role: "risk_explanation",
  profileId: "profile-a",
  revisionId: "revision-a",
  revisionNumber: 1,
  model: "runtime-model",
  modelName: "runtime-model",
  providerName: "must-not-leak",
  endpoint: "https://llm.example.com/v1/chat/completions",
  apiStyle: "chat_completions",
  apiKey: "sk-secret",
};

test("runtime explanation prompts are versioned and hashed", async () => {
  const prompt = await resolveRuntimeExplanationPrompt("market_summary");
  assert.match(prompt.version, /^runtime-market-summary-v\d+$/);
  assert.match(prompt.hash, /^[a-f0-9]{64}$/);
  assert.match(prompt.system, /不能修改|不得修改/);
});

test("runtime explanation output is strict, bounded, and contains no decision channel", () => {
  assert.deepEqual(validateRuntimeExplanationOutput({
    summary: "确定性风控因回撤边界拒绝开仓。",
    evidenceRefs: ["risk.rejectionReasons[0]"],
    cautions: ["解释不构成交易指令"],
  }), {
    summary: "确定性风控因回撤边界拒绝开仓。",
    evidenceRefs: ["risk.rejectionReasons[0]"],
    cautions: ["解释不构成交易指令"],
  });
  assert.throws(() => validateRuntimeExplanationOutput({
    summary: "允许开仓",
    evidenceRefs: [],
    cautions: [],
    decision: { riskApproved: true },
  }), /不允许的字段/);
});

test("runtime explanation calls a pinned model and returns only public structured output", async () => {
  let authorization = "";
  const result = await callRuntimeExplanationAgent({
    config,
    role: "risk_explanation",
    context: {
      deterministicConclusion: "确定性风控拒绝新开仓",
      evidence: { rejectionReasons: ["最大回撤边界已触发"] },
      decision: { action: "enter_long", riskApproved: false },
    },
    resolver: async () => [{ address: "203.0.114.20" }],
    fetchImpl: async (_url, init) => {
      authorization = new Headers(init.headers).get("authorization") || "";
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          summary: "回撤已越过固定上限，因此本周期不产生订单。",
          evidenceRefs: ["evidence.rejectionReasons[0]"],
          cautions: ["模型解释不改变风控结论"],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(authorization, "Bearer sk-secret");
  assert.equal(result.modelName, "runtime-model");
  assert.equal(result.output.summary, "回撤已越过固定上限，因此本周期不产生订单。");
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(result).includes("sk-secret"), false);
});
