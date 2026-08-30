import type { AgentRole } from "./ai-control-plane-compatibility.ts";

export type ResolvedLlmProfileConfig<Role extends string = string> = {
  role: Role;
  profileId: string;
  revisionId?: string;
  revisionNumber?: number;
  model: string;
  modelName: string;
  providerName: string;
  endpoint: string;
  apiStyle: "chat_completions" | "responses";
  apiKey: string;
};

export type ResolvedAgentRoleConfig = ResolvedLlmProfileConfig<AgentRole>;
