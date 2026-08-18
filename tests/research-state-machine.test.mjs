import assert from "node:assert/strict";
import test from "node:test";

import {
  nextResearchStage,
  researchStageProgress,
  requiredAgentRolesForStage,
} from "../lib/strategy-research-state-machine.ts";

test("advances through a fixed deterministic research pipeline", () => {
  const visited = [];
  let stage = "requirements";
  while (stage !== "completed") {
    visited.push(stage);
    stage = nextResearchStage(stage);
  }
  visited.push(stage);

  assert.deepEqual(visited, [
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
  ]);
  assert.equal(researchStageProgress("requirements"), 5);
  assert.equal(researchStageProgress("completed"), 100);
});

test("binds only LLM stages to explicit roles and keeps deterministic stages role-free", () => {
  assert.deepEqual(requiredAgentRolesForStage("requirements"), ["requirements"]);
  assert.deepEqual(requiredAgentRolesForStage("proposing"), ["proposal_a", "proposal_b"]);
  assert.deepEqual(requiredAgentRolesForStage("adversarial_review"), ["adversarial_review"]);
  assert.deepEqual(requiredAgentRolesForStage("risk_review"), ["risk_review"]);
  assert.deepEqual(requiredAgentRolesForStage("reporting"), ["report"]);
  assert.deepEqual(requiredAgentRolesForStage("data_loading"), []);
  assert.deepEqual(requiredAgentRolesForStage("optimizing"), []);
  assert.deepEqual(requiredAgentRolesForStage("ranking"), []);
});

test("rejects unknown or terminal stage transitions", () => {
  assert.throws(() => nextResearchStage("completed"), /终态/);
  assert.throws(() => nextResearchStage("freeform_agent_loop"), /未知/);
});
