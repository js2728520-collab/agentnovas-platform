import { randomUUID } from "node:crypto";

import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { requireUser, responseError } from "@/lib/session";
import { isCustomerTradingEmergencyStopped } from "@/lib/trading-emergency";
import { pinFollowContract, resolveCustomerFollowFeeBps } from "@/lib/strategy-follow-contract";
import { evaluateFollowSpotAdmission } from "@/packages/domain/src/follow-spot-admission";
import { isPubliclyVisibleListingState } from "@/packages/domain/src/strategy-listing-state";

const DISCLOSURE = [
  "模拟跟单不产生真实订单，盈亏为服务器记账结果，不可提取。",
  "策略表现不代表未来收益；作者可能修改或下架策略。",
  "绩效分成按 UTC 自然周与高水位线结算，亏损周不计费。",
].join("\n");

/**
 * 开启一个模拟跟单（T4.4）。
 *
 * 实盘跟单仍然关闭——这里开的是 **paper**：服务器记账的模拟成交，不碰客户的交易所账户。
 *
 * 客户确认的那一刻会固定一份跟单合同（策略版本、费率、风险参数、披露摘要），此后作者改版本、
 * 平台改费率都不影响这次跟随（INV-5）。订阅落在 `user_confirmed`——首个决策周期把它转成
 * `active`，「已确认」与「已在跑」是两件事。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    if (await isCustomerTradingEmergencyStopped(me.id)) {
      return Response.json({ error: "当前所属范围处于紧急停止状态，暂不能开启策略跟随" }, { status: 503 });
    }
    const body = await readResearchJson(request, 4_096);
    const allowedFields = new Set(["capitalPct", "stopLossPct", "acceptDisclosure"]);
    const unknownFields = Object.keys(body).filter((key) => !allowedFields.has(key)).sort();
    if (unknownFields.length > 0) {
      throw new ResearchApiError(
        "FOLLOW_INPUT_UNKNOWN_FIELDS",
        "跟单请求包含不允许的字段",
        422,
        { fields: unknownFields },
      );
    }
    // 披露必须被显式确认。默认同意等于没有确认。
    if (body.acceptDisclosure !== true) {
      throw new ResearchApiError("FOLLOW_DISCLOSURE_REQUIRED", "请先确认跟单风险披露", 422);
    }
    const capitalPct = Number(body.capitalPct);
    const stopLossPct = Number(body.stopLossPct);
    if (!Number.isFinite(capitalPct) || capitalPct <= 0 || capitalPct > 100) {
      throw new ResearchApiError("FOLLOW_CAPITAL_PCT_INVALID", "每单占比必须是 0–100 之间的数值", 422);
    }
    if (!Number.isFinite(stopLossPct) || stopLossPct <= 0 || stopLossPct > 100) {
      throw new ResearchApiError("FOLLOW_STOP_LOSS_INVALID", "止损线必须是 0–100 之间的数值", 422);
    }

    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const strategy = (await client.query<{
        id: string; author_user_id: string; status: string; version: number;
        publication_mode: "marketplace" | "self_use";
        version_id: string; specification_json: string;
      }>(`
        SELECT strategy.id, strategy.author_user_id, strategy.status, strategy.version,
               strategy.publication_mode,
               version.id AS version_id, version.specification_json
          FROM community_strategies AS strategy
          JOIN strategy_versions AS version
            ON version.strategy_id = strategy.id AND version.version = strategy.version
         WHERE strategy.id = $1
      `, [id])).rows[0];
      if (!strategy) throw new ResearchApiError("STRATEGY_NOT_FOUND", "策略不存在", 404);
      // 只有已上架的策略可以被跟随。审核中与已下架的都不对外可见。
      if (!isPubliclyVisibleListingState(strategy.status as never)) {
        throw new ResearchApiError("STRATEGY_NOT_LISTED", "该策略当前不可跟随", 409);
      }
      if (strategy.author_user_id === me.id) {
        throw new ResearchApiError("FOLLOW_SELF_NOT_ALLOWED", "不能跟随自己的策略", 409);
      }

      // 现货准入：做空与双向策略在现货模拟盘上跑不了，且不做降级执行。
      const admission = evaluateFollowSpotAdmission(JSON.parse(strategy.specification_json));
      if (!admission.admitted) {
        throw new ResearchApiError(
          "FOLLOW_NOT_ADMITTED_ON_SPOT",
          admission.reason === "direction_not_long_only"
            ? "现货模拟盘只支持只做多的策略，该策略暂不可跟随"
            : "该策略规格不支持现货模拟跟单",
          409,
          { reason: admission.reason },
        );
      }

      const existing = (await client.query<{ id: string; status: string }>(
        "SELECT id, status FROM strategy_subscriptions WHERE strategy_id=$1 AND customer_id=$2 FOR UPDATE",
        [id, me.id],
      )).rows[0];
      if (existing && existing.status !== "stopped") {
        // 已在跟随时返回原订阅而不是报错：重复点击不该变成一个错误。
        await client.query("COMMIT");
        return Response.json({ subscriptionId: existing.id, status: existing.status, replayed: true });
      }

      const subscriptionId = existing?.id ?? randomUUID();
      const feeBps = await resolveCustomerFollowFeeBps(client, me.id);
      const now = new Date().toISOString();
      if (existing) {
        // 重新跟随同一策略：复用订阅行（唯一索引限制），但合同是新的一份。
        await client.query(`
          UPDATE strategy_subscriptions
             SET status='user_confirmed', strategy_version_id=$2, run_mode='paper',
                 capital_pct=$3, stop_loss_pct=$4, risk_consent_at=$5, started_at=$5,
                 ended_at=NULL, ended_by=NULL, ended_reason=NULL,
                 paused_by=NULL, paused_at=NULL, paused_reason=NULL, updated_at=$5
           WHERE id=$1
        `, [subscriptionId, strategy.version_id, capitalPct, stopLossPct, now]);
      } else {
        await client.query(`
          INSERT INTO strategy_subscriptions(
            id, strategy_id, customer_id, status, strategy_version_id, run_mode,
            capital_pct, stop_loss_pct, risk_consent_at, started_at
          ) VALUES ($1,$2,$3,'user_confirmed',$4,'paper',$5,$6,$7,$7)
        `, [subscriptionId, id, me.id, strategy.version_id, capitalPct, stopLossPct, now]);
      }

      const portfolioId = randomUUID();
      await client.query(`
        INSERT INTO strategy_follow_paper_portfolios(id, subscription_id, customer_id, strategy_id)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (subscription_id) DO NOTHING
      `, [portfolioId, subscriptionId, me.id, id]);
      const portfolio = (await client.query<{ id: string }>(
        "SELECT id FROM strategy_follow_paper_portfolios WHERE subscription_id=$1", [subscriptionId],
      )).rows[0];

      const contract = await pinFollowContract(client, {
        subscriptionId,
        strategyId: id,
        customerId: me.id,
        authorUserId: strategy.author_user_id,
        strategyVersionId: strategy.version_id,
        strategyVersion: strategy.version,
        performanceFeeBps: feeBps,
        publicationMode: strategy.publication_mode,
        risk: { capitalPct, stopLossPct },
        disclosureText: DISCLOSURE,
      });

      await client.query(`
        INSERT INTO strategy_deployments(
          id, owner_user_id, strategy_id, strategy_version_id, mode, status, validation_label,
          idempotency_key, execution_product, strategy_subscription_id, follow_paper_portfolio_id, next_cycle_at
        ) VALUES ($1,$2,$3,$4,'paper','active','UNVERIFIED',$5,'spot_usdt',$6,$7,now())
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [randomUUID(), me.id, id, strategy.version_id, `follow:${subscriptionId}`, subscriptionId, portfolio.id]);

      await client.query("COMMIT");
      return Response.json({
        subscriptionId,
        contractId: contract.id,
        status: "user_confirmed",
        performanceFeeBps: feeBps,
        // 客户要知道自己确认的是哪一版披露。
        disclosureSha256: contract.disclosureSha256,
        mode: "paper",
      }, { status: 201 });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return responseError(error);
  }
}
