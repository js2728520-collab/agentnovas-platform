import assert from "node:assert/strict";
import test from "node:test";

import { parseOfficialPaperTradeLimit } from "../lib/official-paper-pagination.ts";
import { ResearchApiError } from "../lib/research-errors.ts";

test("official paper trade limit defaults to 50 and accepts bounded integers", () => {
  assert.equal(parseOfficialPaperTradeLimit(null), 50);
  assert.equal(parseOfficialPaperTradeLimit(""), 50);
  assert.equal(parseOfficialPaperTradeLimit("1"), 1);
  assert.equal(parseOfficialPaperTradeLimit("100"), 100);
});

test("official paper trade limit rejects NaN, fractions, and out-of-range values with 422", () => {
  for (const value of ["NaN", "wat", "1.5", "0", "101", "Infinity"]) {
    assert.throws(
      () => parseOfficialPaperTradeLimit(value),
      (error) => error instanceof ResearchApiError
        && error.status === 422
        && error.details?.fields?.includes("limit"),
      value,
    );
  }
});
