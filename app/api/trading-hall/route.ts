import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { exchangeAccounts, platformDecisions, trades } from "@/db/schema";
import { requireUser, responseError } from "@/lib/session";

const strategyCodes = ["ai_conservative", "ai_balanced", "ai_aggressive"];
const names: Record<string, string> = {
  ai_conservative: "AI 稳健型",
  ai_balanced: "AI 平衡型",
  ai_aggressive: "AI 激进型",
};

function parseEvidence(value: string) {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function agentTalksFrom(
  decisions: Array<{
    id: string;
    strategyCode: string;
    status: string;
    symbol: string;
    evidenceJson: string;
    updatedAt: Date | string;
  }>,
) {
  return decisions.flatMap((row) => {
    const evidence = parseEvidence(row.evidenceJson);
    const recordedAgentMessages = Array.isArray(evidence.agentMessages)
      ? evidence.agentMessages.flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const message = item as Record<string, unknown>;
          if (!message.agent || !message.message) return [];
          return [{
            agent: String(message.agent),
            message: String(message.message),
            strategyCode: row.strategyCode,
            strategyName: names[row.strategyCode],
            decisionId: row.id,
            status: row.status,
            updatedAt: row.updatedAt,
            source: "platform_decision",
          }];
        })
      : [];
    if (recordedAgentMessages.length) return recordedAgentMessages;
    const recordedMessage = evidence.agentMessage ?? evidence.summary ?? evidence.reason;
    const message = recordedMessage
      ? String(recordedMessage)
      : `${row.symbol} 决策状态已更新为 ${row.status}`;

    return [{
      agent: evidence.agentName ? String(evidence.agentName) : "策略工作流",
      message,
      strategyCode: row.strategyCode,
      strategyName: names[row.strategyCode],
      decisionId: row.id,
      status: row.status,
      updatedAt: row.updatedAt,
      source: "platform_decision",
    }];
  }).slice(0, 42);
}

export async function GET(request: Request) {
  try {
    const me = await requireUser(request, ["customer"]);
    const db = getDb();
    const decisions = await db
      .select({
        id: platformDecisions.id,
        strategyCode: platformDecisions.strategyCode,
        strategyVersion: platformDecisions.strategyVersion,
        symbol: platformDecisions.symbol,
        status: platformDecisions.status,
        evidenceJson: platformDecisions.evidenceJson,
        agentTaskId: platformDecisions.agentTaskId,
        riskApprovalId: platformDecisions.riskApprovalId,
        updatedAt: platformDecisions.updatedAt,
        exchange: exchangeAccounts.exchange,
        environment: exchangeAccounts.environment,
      })
      .from(platformDecisions)
      .innerJoin(exchangeAccounts, eq(exchangeAccounts.id, platformDecisions.exchangeAccountId))
      .where(
        and(
          eq(platformDecisions.customerId, me.id),
          inArray(platformDecisions.strategyCode, strategyCodes),
        ),
      )
      .orderBy(desc(platformDecisions.updatedAt))
      .limit(100);

    const tradeRows = await db
      .select()
      .from(trades)
      .where(
        and(eq(trades.customerId, me.id), inArray(trades.strategyCode, strategyCodes)),
      )
      .orderBy(desc(trades.updatedAt))
      .limit(300);

    const strategies = strategyCodes.map((code) => {
      const strategyDecisions = decisions.filter((item) => item.strategyCode === code);
      const strategyTrades = tradeRows.filter((item) => item.strategyCode === code);
      const open = strategyTrades.filter((item) => !item.closedAt);
      const latest = strategyDecisions[0];
      const evidence = latest ? parseEvidence(latest.evidenceJson) : {};

      return {
        code,
        name: names[code],
        status: latest?.status || "idle",
        version: latest?.strategyVersion || null,
        exchange: latest?.exchange || null,
        environment: latest?.environment || null,
        lastUpdatedAt: latest?.updatedAt || null,
        openPositions: open.length,
        unrealizedReferenceUsdt: open.reduce(
          (total, item) => total + item.realizedNetPnlUsdt,
          0,
        ),
        latestDecision: latest
          ? {
              id: latest.id,
              symbol: latest.symbol,
              status: latest.status,
              riskApprovalId: latest.riskApprovalId,
              agentTaskId: latest.agentTaskId,
              evidence,
            }
          : null,
      };
    });

    return Response.json(
      {
        strategies,
        agentTalks: agentTalksFrom(decisions),
        activities: decisions.slice(0, 30).map((item) => ({
          id: item.id,
          strategyCode: item.strategyCode,
          strategyName: names[item.strategyCode],
          status: item.status,
          symbol: item.symbol,
          updatedAt: item.updatedAt,
          evidence: parseEvidence(item.evidenceJson),
        })),
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return responseError(error);
  }
}
