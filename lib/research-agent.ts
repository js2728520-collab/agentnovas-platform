import type { ResolvedAgentRoleConfig } from "./research-types.ts";
import { assertPublicLlmEndpoint } from "./llm-profile-connection.ts";
import { resolveResearchPrompt } from "./research-prompt-registry.ts";
import { normalizeStrategyDslV3 } from "../packages/domain/src/strategy-dsl.ts";

type ResearchAgentRole = ResolvedAgentRoleConfig["role"];

const defaultRoleConclusions: Record<ResearchAgentRole, string> = {
  requirements: "研发需求已结构化",
  market_regime: "市场状态分段已完成",
  proposal_a: "提案 A 已生成",
  proposal_b: "提案 B 已生成",
  adversarial_review: "反方审查已完成",
  risk_review: "风险审核已完成",
  report: "研发报告已生成",
};

function boundedContext(value: unknown) {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > 48_000) throw new Error("Agent 上下文超过 48KB 限制");
  return json;
}

function extractText(payload: unknown, apiStyle: "chat_completions" | "responses") {
  if (!payload || typeof payload !== "object") throw new Error("模型响应格式无效");
  const root = payload as Record<string, unknown>;
  if (apiStyle === "chat_completions") {
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const message = choices[0] && typeof choices[0] === "object"
      ? (choices[0] as Record<string, unknown>).message
      : null;
    const content = message && typeof message === "object"
      ? (message as Record<string, unknown>).content
      : null;
    if (typeof content === "string") return content;
  } else {
    if (typeof root.output_text === "string") return root.output_text;
    const output = Array.isArray(root.output) ? root.output : [];
    const texts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = Array.isArray((item as Record<string, unknown>).content)
        ? (item as Record<string, unknown>).content as unknown[]
        : [];
      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
          texts.push((part as Record<string, unknown>).text as string);
        }
      }
    }
    if (texts.length) return texts.join("\n");
  }
  throw new Error("模型没有返回可解析文本");
}

function parseObject(text: string) {
  if (new TextEncoder().encode(text).byteLength > 100_000) throw new Error("模型响应超过 100KB 限制");
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let output: unknown;
  try {
    output = JSON.parse(normalized);
  } catch {
    throw new Error("模型未返回有效 JSON");
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("模型 JSON 必须是对象");
  return output as Record<string, unknown>;
}

export function researchAgentTimeoutMs(environment: Record<string, string | undefined> = process.env) {
  const configured = Number(environment.STRATEGY_RESEARCH_AGENT_TIMEOUT_MS);
  const requested = Number.isFinite(configured) && configured > 0 ? configured : 90_000;
  return Math.min(Math.max(requested, 5_000), 90_000);
}

const requirementBriefKeys = new Set([
  "symbol", "timeframe", "direction", "objective", "maxDrawdownPct",
  "positionSizePct", "maxDailyLossPct", "maxConsecutiveLosses", "slippageRate", "candleCount",
]);

function normalizeRequirementBrief(value: Record<string, unknown>) {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!requirementBriefKeys.has(key)) throw new Error(`需求 Agent 返回了不允许的 brief 字段：${key}`);
    if (key === "direction" && item == null) continue;
    if (typeof item === "string") {
      const normalized = item.trim();
      if (!normalized && key === "direction") continue;
      if (!normalized || item.length > 500) throw new Error(`需求字段 ${key} 无效`);
      if (key === "direction" && !["long_only", "short_only", "both"].includes(normalized)) {
        throw new Error("需求字段 direction 必须是 long_only、short_only 或 both");
      }
      result[key] = normalized;
    } else if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error(`需求字段 ${key} 无效`);
      result[key] = item;
    } else if (typeof item === "boolean") result[key] = item;
    else throw new Error(`需求字段 ${key} 类型无效`);
  }
  return result;
}

function validateOutput(role: ResearchAgentRole, output: Record<string, unknown>) {
  const nestedResult = output.result && typeof output.result === "object" && !Array.isArray(output.result)
    ? output.result as Record<string, unknown>
    : null;
  if (nestedResult) {
    for (const [key, value] of Object.entries(nestedResult)) {
      if (output[key] === undefined) output[key] = value;
    }
  }
  if (role === "market_regime" && !Array.isArray(output.regimes)) {
    const aliases = [output.segments, output.marketSegments, output.regimeSegments, output.market_regimes];
    const regimes = aliases.find(Array.isArray);
    if (regimes) output.regimes = regimes;
  }
  if (typeof output.conclusion !== "string" || !output.conclusion.trim()) {
    output.conclusion = defaultRoleConclusions[role];
  }
  if (Array.isArray(output.dataReferences)) output.dataReferences = output.dataReferences.slice(0, 50);
  else if (typeof output.dataReferences === "string" && output.dataReferences.trim()) {
    output.dataReferences = [output.dataReferences.trim()];
  } else output.dataReferences = [];
  if (role === "requirements") {
    if (!output.brief || typeof output.brief !== "object" || Array.isArray(output.brief)) throw new Error("需求 Agent 未返回 brief");
    if (!Array.isArray(output.missingFields)) throw new Error("需求 Agent 未返回 missingFields");
    output.brief = normalizeRequirementBrief(output.brief as Record<string, unknown>);
    const supportedMissingFields = output.missingFields.filter(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      return requirementBriefKeys.has(String((item as Record<string, unknown>).key ?? "").trim());
    });
    if (supportedMissingFields.length > 8) throw new Error("需求 Agent 追问数量超过限制");
    output.missingFields = supportedMissingFields.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`需求追问 ${index + 1} 格式无效`);
      const field = item as Record<string, unknown>;
      const key = String(field.key ?? "").trim();
      const question = String(field.question ?? "").trim();
      if (!question || question.length > 300) throw new Error(`需求追问 ${index + 1} 的问题无效`);
      const options = field.options === undefined ? [] : field.options;
      if (!Array.isArray(options) || options.length > 6 || options.some(option => !["string", "number", "boolean"].includes(typeof option))) {
        throw new Error(`需求追问 ${index + 1} 的候选项无效`);
      }
      const defaultValue = field.defaultValue ?? options[0] ?? "";
      if (!["string", "number", "boolean"].includes(typeof defaultValue)) throw new Error(`需求追问 ${index + 1} 的默认值无效`);
      return { key, question, options, defaultValue };
    });
    const normalizedBrief = output.brief as Record<string, unknown>;
    const normalizedMissingFields = output.missingFields as Array<Record<string, unknown>>;
    if (!normalizedBrief.direction && !normalizedMissingFields.some(field => field.key === "direction")) {
      if (normalizedMissingFields.length >= 8) throw new Error("需求 Agent 追问数量超过限制");
      normalizedMissingFields.push({
        key: "direction",
        question: "请选择策略交易方向",
        options: ["long_only", "short_only", "both"],
        defaultValue: "long_only",
      });
    }
  }
  if (role === "market_regime") {
    if (!Array.isArray(output.regimes)) {
      const returnedFields = Object.keys(output).filter(key => key !== "result").slice(0, 12).join(", ");
      throw new Error(`市场状态 Agent 未返回 regimes${returnedFields ? `（返回字段：${returnedFields}）` : ""}`);
    }
    output.regimes = output.regimes.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`市场状态分段 ${index + 1} 格式无效`);
      const regime = item as Record<string, unknown>;
      const segmentId = String(regime.segmentId ?? "").trim();
      const label = String(regime.label ?? "").trim();
      if (!/^segment-\d{1,2}$/.test(segmentId)) throw new Error(`市场状态分段 ${index + 1} 未引用有效 segmentId`);
      if (!["trend", "range", "high_volatility", "extreme_decline"].includes(label)) {
        throw new Error(`市场状态分段 ${index + 1} 标签无效`);
      }
      const evidence = Array.isArray(regime.evidence)
        ? regime.evidence.slice(0, 10)
        : typeof regime.evidence === "string" && regime.evidence.trim()
          ? [regime.evidence.trim()]
          : [];
      return { segmentId, label, evidence };
    });
  }
  if (role === "proposal_a" || role === "proposal_b") {
    if (!Array.isArray(output.candidates)) throw new Error("提案 Agent 未返回 candidates 数组");
    const validCandidates: Array<{ strategyFamily: string; dsl: ReturnType<typeof normalizeStrategyDslV3> }> = [];
    const rejectedCandidates: Array<{ index: number; strategyFamily: string; reason: string }> = [];
    for (const [index, item] of output.candidates.slice(0, 12).entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        rejectedCandidates.push({ index: index + 1, strategyFamily: "未命名候选", reason: "候选格式无效" });
        continue;
      }
      const candidate = item as Record<string, unknown>;
      const strategyFamily = String(candidate.strategyFamily ?? candidate.strategy_family ?? candidate.family ?? "").trim();
      if (!strategyFamily || strategyFamily.length > 80) {
        rejectedCandidates.push({ index: index + 1, strategyFamily: strategyFamily || "未命名候选", reason: "策略家族无效" });
        continue;
      }
      try {
        let rawDsl = candidate.dsl ?? candidate.strategyDsl ?? candidate.dslV2 ?? candidate.strategy;
        if (typeof rawDsl === "string") rawDsl = JSON.parse(rawDsl);
        if (rawDsl === undefined && candidate.schemaVersion !== undefined) {
          const inlineDsl = { ...candidate };
          delete inlineDsl.strategyFamily;
          delete inlineDsl.strategy_family;
          delete inlineDsl.family;
          rawDsl = inlineDsl;
        }
        if (rawDsl && typeof rawDsl === "object" && !Array.isArray(rawDsl)) {
          const dslRecord = rawDsl as Record<string, unknown>;
          if (dslRecord.schemaVersion === undefined && dslRecord.version === 3) {
            const withSchemaVersion: Record<string, unknown> = { ...dslRecord, schemaVersion: 3 };
            delete withSchemaVersion.version;
            rawDsl = withSchemaVersion;
          }
        }
        validCandidates.push({ strategyFamily, dsl: normalizeStrategyDslV3(rawDsl) });
      } catch (error) {
        rejectedCandidates.push({
          index: index + 1,
          strategyFamily,
          reason: `DSL 校验未通过：${error instanceof Error ? error.message : "未知错误"}`,
        });
      }
    }
    output.candidates = validCandidates;
    output.rejectedCandidates = rejectedCandidates;
  }
  if (role === "adversarial_review") {
    if (typeof output.verdict !== "string") throw new Error("反方审查 Agent 未返回 verdict");
    if (!Array.isArray(output.objections)) throw new Error("反方审查 Agent 未返回 objections");
    if (!Array.isArray(output.revisionRequests)) throw new Error("反方审查 Agent 未返回 revisionRequests");
  }
  if (role === "risk_review") {
    if (typeof output.verdict !== "string") throw new Error("风控 Agent 未返回 verdict");
    if (!Array.isArray(output.vetoReasons)) throw new Error("风控 Agent 未返回 vetoReasons");
    if (!Array.isArray(output.boundaries)) throw new Error("风控 Agent 未返回 boundaries");
  }
  if (role === "report") {
    if (typeof output.recommendedCandidateId !== "string") throw new Error("报告 Agent 未返回 recommendedCandidateId");
    if (typeof output.summary !== "string") throw new Error("报告 Agent 未返回 summary");
    if (!Array.isArray(output.risks)) throw new Error("报告 Agent 未返回 risks");
  }
  return output;
}

export async function callStructuredResearchAgent(options: {
  config: ResolvedAgentRoleConfig;
  role: ResearchAgentRole;
  context: Record<string, unknown>;
  /** 研发运行创建时固定的 Prompt 配置指令（PS-05）。省略则用代码内定义。 */
  promptInstruction?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  resolver?: (hostname: string) => Promise<Array<{ address: string }>>;
}) {
  if (options.config.role !== options.role) throw new Error("Agent 角色与模型绑定不匹配");
  const prompt = await resolveResearchPrompt(options.role, options.promptInstruction);
  const system = prompt.system;
  const user = `以下是只读上下文：\n<research_context>${boundedContext(options.context)}</research_context>`;
  const body = options.config.apiStyle === "responses"
    ? { model: options.config.model, instructions: system, input: user, max_output_tokens: 8_000 }
    : { model: options.config.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 8_000, temperature: 0.2 };
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs === undefined
    ? researchAgentTimeoutMs()
    : Math.min(Math.max(options.timeoutMs, 5_000), 90_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await assertPublicLlmEndpoint(options.config.endpoint, options.resolver);
    const response = await (options.fetchImpl ?? fetch)(options.config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.config.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Agent 模型请求失败（HTTP ${response.status}）`);
    const output = validateOutput(options.role, parseObject(extractText(await response.json(), options.config.apiStyle)));
    if (options.role === "market_regime") {
      const marketData = options.context.marketData && typeof options.context.marketData === "object"
        ? options.context.marketData as Record<string, unknown>
        : options.context;
      const evidence = Array.isArray(marketData.regimeEvidence) ? marketData.regimeEvidence : [];
      const allowed = new Set(evidence.map(item => item && typeof item === "object" ? String((item as Record<string, unknown>).segmentId ?? "") : ""));
      for (const regime of output.regimes as Array<{ segmentId: string }>) {
        if (!allowed.has(regime.segmentId)) throw new Error(`市场状态 Agent 引用了不存在的分段：${regime.segmentId}`);
      }
    }
    return {
      role: options.role,
      modelName: options.config.modelName,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      output,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Agent 模型调用超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
