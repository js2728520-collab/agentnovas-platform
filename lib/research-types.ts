import type { AgentRole } from "./agent-model-profiles.ts";

export type ResolvedAgentRoleConfig = {
  role: AgentRole;
  profileId: string;
  model: string;
  modelName: string;
  providerName: string;
  endpoint: string;
  apiStyle: "chat_completions" | "responses";
  apiKey: string;
};
