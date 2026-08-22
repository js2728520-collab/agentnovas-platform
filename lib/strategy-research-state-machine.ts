export const researchStages = [
  "requirements",
  "data_loading",
  "regime_analysis",
  "proposing",
  "validating",
  "optimizing",
  "adversarial_review",
  "risk_review",
  "ranking",
  "reporting",
  "completed",
] as const;

export type ResearchStage = typeof researchStages[number];

export type AgentRole =
  | "requirements"
  | "market_regime"
  | "proposal_a"
  | "proposal_b"
  | "adversarial_review"
  | "risk_review"
  | "report";

const progressByStage: Record<ResearchStage, number> = {
  requirements: 5,
  data_loading: 15,
  regime_analysis: 25,
  proposing: 38,
  validating: 52,
  optimizing: 65,
  adversarial_review: 75,
  risk_review: 84,
  ranking: 92,
  reporting: 97,
  completed: 100,
};

const rolesByStage: Record<ResearchStage, AgentRole[]> = {
  requirements: ["requirements"],
  data_loading: [],
  regime_analysis: ["market_regime"],
  proposing: ["proposal_a", "proposal_b"],
  validating: [],
  optimizing: [],
  adversarial_review: ["adversarial_review"],
  risk_review: ["risk_review"],
  ranking: [],
  reporting: ["report"],
  completed: [],
};

function assertResearchStage(value: string): ResearchStage {
  if (!(researchStages as readonly string[]).includes(value)) throw new Error(`未知研发阶段：${value}`);
  return value as ResearchStage;
}

export function nextResearchStage(current: string): ResearchStage {
  const stage = assertResearchStage(current);
  if (stage === "completed") throw new Error("研发任务已处于终态");
  return researchStages[researchStages.indexOf(stage) + 1];
}

export function researchStageProgress(value: string) {
  return progressByStage[assertResearchStage(value)];
}

export function requiredAgentRolesForStage(value: string) {
  return [...rolesByStage[assertResearchStage(value)]];
}
