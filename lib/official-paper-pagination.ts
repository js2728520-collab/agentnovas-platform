import { ResearchApiError } from "./research-errors.ts";

export function parseOfficialPaperTradeLimit(value: string | null) {
  if (value === null || value === "") return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ResearchApiError("VALIDATION_ERROR", "模拟成交数量限制无效", 422, {
      fields: ["limit"],
    });
  }
  return limit;
}
