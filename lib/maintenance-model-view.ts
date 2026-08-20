type LlmProfileViewSource = {
  id: string;
  name: string;
  providerName: string;
  modelName: string;
  hasApiKey: boolean;
  enabled: boolean;
  currentRevisionId: string | null;
  updatedAt: Date | string;
};

export function maintenanceLlmProfileView(profile: LlmProfileViewSource) {
  return {
    id: profile.id,
    name: profile.name,
    providerName: profile.providerName,
    modelName: profile.modelName,
    hasSecret: profile.hasApiKey,
    enabled: profile.enabled,
    currentRevisionId: profile.currentRevisionId,
    updatedAt: profile.updatedAt,
  };
}
