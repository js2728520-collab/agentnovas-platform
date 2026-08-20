import type { PoolClient } from "pg";

import { previousCompleteUtcWeek } from "./commercial-api-support.ts";
import {
  aggregateOfficialThreeCardPreviousUtcWeek,
} from "./official-paper-repository.ts";
import { ResearchApiError } from "./research-errors.ts";
import { officialTradingHallStrategies } from "../packages/contracts/src/trading-hall.ts";

type OfficialThreeCardAggregate = Awaited<
  ReturnType<typeof aggregateOfficialThreeCardPreviousUtcWeek>
>;
export type OfficialThreeCardAggregateReader = (
  client: Pick<PoolClient, "query">,
  input: { membershipId: string; customerId: string; asOf?: Date },
) => Promise<OfficialThreeCardAggregate>;

export type OfficialThreeCardPortfolioScopeResolver = (
  client: PoolClient,
  input: { membershipId: string; customerId: string; asOf: Date },
) => Promise<OfficialThreeCardAggregate>;

const exactDecimal = /^-?\d+\.\d{12}$/u;

function invalidScope(): never {
  throw new ResearchApiError(
    "OFFICIAL_PORTFOLIO_SCOPE_INVALID",
    "官方三卡组合或周结算范围不完整",
    503,
  );
}

function validateAggregate(
  value: OfficialThreeCardAggregate,
  input: { membershipId: string; customerId: string; asOf: Date },
) {
  const expectedPeriod = previousCompleteUtcWeek(input.asOf);
  if (
    value.customerId !== input.customerId ||
    value.membershipId !== input.membershipId ||
    value.scopeKey !== `official-three:${input.membershipId}` ||
    value.scopeVersion !== "official-paper-closed-sells-v1" ||
    value.period?.start !== expectedPeriod.weekStart ||
    value.period?.end !== expectedPeriod.weekEnd ||
    value.periodStart !== expectedPeriod.weekStart ||
    value.periodEnd !== expectedPeriod.weekEnd
  ) {
    invalidScope();
  }

  const expectedStrategies = officialTradingHallStrategies.map(
    ({ code }) => ({
      strategyCode: code,
      portfolioId: `official-paper:${input.membershipId}:${code}`,
    }),
  );
  if (
    value.strategies.length !== expectedStrategies.length ||
    expectedStrategies.some((expected, index) => {
      const actual = value.strategies[index];
      return (
        actual?.strategyCode !== expected.strategyCode ||
        actual.portfolioId !== expected.portfolioId
      );
    })
  ) {
    invalidScope();
  }

  const decimals = [
    value.weekNetPnl,
    value.cumulativeNetPnl,
    value.priorNetPnl,
    value.realizedGrossPnlUsdt,
    value.realizedNetPnlUsdt,
    value.feesUsdt,
    ...value.strategies.flatMap((strategy) => [
      strategy.realizedGrossPnlUsdt,
      strategy.realizedNetPnlUsdt,
      strategy.feesUsdt,
      strategy.cumulativeNetPnl,
      strategy.priorNetPnl,
    ]),
  ];
  if (decimals.some((decimal) => !exactDecimal.test(decimal))) invalidScope();
  return value;
}

/**
 * Resolves the performance-fee scope from trusted entitlement identity only.
 * Request-selected strategy or portfolio identifiers are deliberately absent.
 */
export async function resolveCommercialOfficialPaperScope(
  client: PoolClient,
  input: { membershipId: string; customerId: string; asOf: Date },
  dependencies: { aggregate?: OfficialThreeCardAggregateReader } = {},
) {
  const membershipId = input.membershipId.trim();
  const customerId = input.customerId.trim();
  if (
    !membershipId ||
    !customerId ||
    !Number.isFinite(input.asOf.getTime())
  ) {
    invalidScope();
  }
  try {
    const value = await (
      dependencies.aggregate ?? aggregateOfficialThreeCardPreviousUtcWeek
    )(client, { membershipId, customerId, asOf: input.asOf });
    return validateAggregate(value, {
      membershipId,
      customerId,
      asOf: input.asOf,
    });
  } catch (error) {
    if (
      error instanceof ResearchApiError &&
      error.code === "OFFICIAL_PORTFOLIO_SCOPE_INVALID"
    ) {
      throw error;
    }
    invalidScope();
  }
}
