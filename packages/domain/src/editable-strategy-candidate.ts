import {
  normalizeResearchStrategyDsl,
  type ResearchStrategyDsl,
} from "./strategy-dsl.ts";

export type StrategyCandidateValidationLabel =
  | "UNVERIFIED"
  | "EXPLORATION_ONLY"
  | "STANDARD_FAILED"
  | "STANDARD_VERIFIED";

function canonicalSpecification(input: unknown) {
  const specification = normalizeResearchStrategyDsl(input);
  return {
    specification,
    json: JSON.stringify(specification),
  };
}

export function strategyCandidateSpecificationsEqual(left: unknown, right: unknown) {
  return canonicalSpecification(left).json === canonicalSpecification(right).json;
}

export function prepareEditableStrategyCandidate(input: {
  candidateSpecification: unknown;
  requestedSpecification?: unknown;
  candidateValidationLabel: StrategyCandidateValidationLabel;
}): {
  specification: ResearchStrategyDsl;
  edited: boolean;
  source: "manual" | "ai_provider";
  validationLabel: StrategyCandidateValidationLabel;
} {
  const candidate = canonicalSpecification(input.candidateSpecification);
  const requested = input.requestedSpecification === undefined
    ? candidate
    : canonicalSpecification(input.requestedSpecification);
  const edited = candidate.json !== requested.json;
  return {
    specification: requested.specification,
    edited,
    source: edited ? "manual" : "ai_provider",
    validationLabel: edited ? "UNVERIFIED" : input.candidateValidationLabel,
  };
}
