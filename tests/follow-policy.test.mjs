import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFollowPolicy } from "../lib/follow-policy.ts";

test("withdrawal authorization is required by default for marketplace follows", () => {
  assert.deepEqual(evaluateFollowPolicy({
    allowFollowWithoutWithdrawal: false,
    withdrawalAuthorized: false,
    publicationMode: "marketplace",
    strategyAuthorId: "author",
    customerId: "customer",
  }), { allowed: false, manualCollectionRequired: false, reason: "withdrawal_authorization_required" });
});

test("admin override permits follow and marks weekly manual collection", () => {
  assert.deepEqual(evaluateFollowPolicy({
    allowFollowWithoutWithdrawal: true,
    withdrawalAuthorized: false,
    publicationMode: "marketplace",
    strategyAuthorId: "author",
    customerId: "customer",
  }), { allowed: true, manualCollectionRequired: true, reason: "admin_override_manual_collection" });
});

test("private self-use strategies remain exempt", () => {
  assert.deepEqual(evaluateFollowPolicy({
    allowFollowWithoutWithdrawal: false,
    withdrawalAuthorized: false,
    publicationMode: "self_use",
    strategyAuthorId: "customer",
    customerId: "customer",
  }), { allowed: true, manualCollectionRequired: false, reason: "private_self_use" });
});
