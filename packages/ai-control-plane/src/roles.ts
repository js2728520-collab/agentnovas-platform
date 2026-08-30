import type { RoleDescriptor } from "./types.ts";

const textRequirement = Object.freeze({
  inputModalities: ["text"],
  outputModalities: ["text"],
});

export const AI_ROLE_CATALOG: readonly RoleDescriptor[] = Object.freeze([
  { key: "research.requirements", consumer: "research", role: "requirements", label: "Requirements", runtimeState: "retired", requirement: textRequirement },
  { key: "research.market_regime", consumer: "research", role: "market_regime", label: "Market regime", runtimeState: "retired", requirement: textRequirement },
  { key: "research.proposal_a", consumer: "research", role: "proposal_a", label: "Proposal A", runtimeState: "retired", requirement: { ...textRequirement, requiresStructuredOutput: true } },
  { key: "research.proposal_b", consumer: "research", role: "proposal_b", label: "Proposal B", runtimeState: "retired", requirement: { ...textRequirement, requiresStructuredOutput: true } },
  { key: "research.adversarial_review", consumer: "research", role: "adversarial_review", label: "Adversarial review", runtimeState: "retired", requirement: textRequirement },
  { key: "research.risk_review", consumer: "research", role: "risk_review", label: "Risk review", runtimeState: "retired", requirement: textRequirement },
  { key: "research.report", consumer: "research", role: "report", label: "Report", runtimeState: "retired", requirement: textRequirement },
  { key: "runtime.market_summary", consumer: "runtime", role: "market_summary", label: "Market summary", runtimeState: "gated", requirement: textRequirement },
  { key: "runtime.adversarial_explanation", consumer: "runtime", role: "adversarial_explanation", label: "Adversarial explanation", runtimeState: "gated", requirement: textRequirement },
  { key: "runtime.risk_explanation", consumer: "runtime", role: "risk_explanation", label: "Risk explanation", runtimeState: "gated", requirement: textRequirement },
  { key: "client.assistant_message", consumer: "client", role: "assistant_message", label: "Assistant message", runtimeState: "gated", requirement: { ...textRequirement, requiresStreaming: true } },
  { key: "client.strategy_generation", consumer: "client", role: "strategy_generation", label: "Strategy generation", runtimeState: "gated", requirement: { ...textRequirement, requiresStructuredOutput: true } },
]);
