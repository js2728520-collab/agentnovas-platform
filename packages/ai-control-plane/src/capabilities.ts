import type { CapabilityRequirement, ModelCapability } from "./types.ts";

export type CapabilityMismatch =
  | "input_modality_not_supported"
  | "output_modality_not_supported"
  | "context_window_too_small"
  | "max_output_too_small"
  | "streaming_not_supported"
  | "structured_output_not_supported";

export function evaluateCapabilities(input: {
  capability: ModelCapability;
  requirement: CapabilityRequirement;
}) {
  const reasons: CapabilityMismatch[] = [];
  if (input.requirement.inputModalities?.some((item) => !input.capability.inputModalities.includes(item))) {
    reasons.push("input_modality_not_supported");
  }
  if (input.requirement.outputModalities?.some((item) => !input.capability.outputModalities.includes(item))) {
    reasons.push("output_modality_not_supported");
  }
  if ((input.requirement.minimumContextWindowTokens ?? 0) > input.capability.contextWindowTokens) {
    reasons.push("context_window_too_small");
  }
  if ((input.requirement.minimumMaxOutputTokens ?? 0) > input.capability.maxOutputTokens) {
    reasons.push("max_output_too_small");
  }
  if (input.requirement.requiresStreaming && !input.capability.supportsStreaming) {
    reasons.push("streaming_not_supported");
  }
  if (input.requirement.requiresStructuredOutput && !input.capability.supportsStructuredOutput) {
    reasons.push("structured_output_not_supported");
  }
  return { compatible: reasons.length === 0, reasons } as const;
}
