import pg from "pg";

import {
  allPlatformStrategyDslV3,
  platformStrategyConversionContractHash,
} from "../lib/platform-strategy-v3.ts";
import { ensureOfficialPaperPortfolios } from "../lib/official-paper-repository.ts";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");

const apply = process.argv.includes("--apply");
const modeArgument = process.argv.find(value => value.startsWith("--mode="));
const mode = modeArgument?.slice("--mode=".length) || "shadow";
if (mode !== "shadow" && mode !== "paper") throw new Error("--mode must be shadow or paper");
const confirmation = process.argv.find(value => value.startsWith("--confirm-contract-hash="))
  ?.slice("--confirm-contract-hash=".length);

const pool = new pg.Pool({ connectionString, max: 2, application_name: "agentnovas-platform-cutover" });

function strategyId(code, symbol) {
  return `platform:${code}:${symbol.toLowerCase()}`;
}

function versionId(code, symbol) {
  return `platform-version:${code}:${symbol.toLowerCase()}:spot-v2`;
}

function subscriptionId(legacyId) {
  return `platform-subscription:${legacyId}`;
}

function deploymentId(legacyId) {
  return `platform-deployment:${legacyId}`;
}

try {
  const contractHash = await platformStrategyConversionContractHash();
  const [admin, legacyCount, openPositions] = await Promise.all([
    pool.query(`SELECT id FROM users WHERE role = 'hq_admin' AND status = 'active' ORDER BY created_at, id LIMIT 1`),
    pool.query(`SELECT count(*)::int AS count FROM platform_strategy_subscriptions`),
    pool.query(`
      SELECT trade.id, trade.customer_id, trade.strategy_code, trade.symbol, trade.status
      FROM trades AS trade
      WHERE trade.origin = 'platform' AND trade.closed_at IS NULL
        AND trade.status NOT IN ('closed', 'cancelled', 'canceled', 'rejected')
      ORDER BY trade.created_at, trade.id
    `),
  ]);
  const report = {
    apply,
    mode,
    contractHash,
    convertedVersionCount: allPlatformStrategyDslV3().length,
    legacySubscriptionCount: legacyCount.rows[0].count,
    activeHeadquartersAdminConfigured: Boolean(admin.rows[0]),
    blockingOpenPositions: openPositions.rows,
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (confirmation !== contractHash) throw new Error(`cutover blocked: pass --confirm-contract-hash=${contractHash}`);
    if (!admin.rows[0]) throw new Error("cutover blocked: no active hq_admin can own platform strategies");
    if (openPositions.rows.length) throw new Error("cutover blocked: legacy platform positions must be closed or explicitly reconciled first");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const authorUserId = admin.rows[0].id;
      const definitions = allPlatformStrategyDslV3();
      for (const item of definitions) {
        const id = strategyId(item.code, item.symbol);
        const revisionId = versionId(item.code, item.symbol);
        const specificationJson = JSON.stringify(item.dsl);
        await client.query(`
          INSERT INTO community_strategies (
            id, author_user_id, name, summary, market, symbols_json, risk_level,
            status, publication_mode, validation_label, specification_json, version,
            approved_at, published_at
          ) VALUES (
            $1, $2, $3, $4, 'crypto', $5, $6,
            'published', 'marketplace', 'UNVERIFIED', $7, 1,
            to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) ON CONFLICT (id) DO UPDATE SET
            specification_json = EXCLUDED.specification_json,
            summary = EXCLUDED.summary,
            version = 2
        `, [
          id, authorUserId, item.dsl.name,
          "由旧平台策略逐条件转换并通过信号黄金测试；仍不代表未来收益。",
          JSON.stringify([item.symbol]),
          item.code === "ai_conservative" ? "low" : item.code === "ai_balanced" ? "medium" : "high",
          specificationJson,
        ]);
        const existing = await client.query(`SELECT specification_json FROM strategy_versions WHERE id = $1`, [revisionId]);
        if (existing.rows[0] && existing.rows[0].specification_json !== specificationJson) {
          throw new Error(`cutover blocked: immutable platform version differs for ${item.code}/${item.symbol}`);
        }
        await client.query(`
          INSERT INTO strategy_versions (
            id, strategy_id, version, name, summary, specification_json, source, created_by_user_id
          ) VALUES ($1, $2, 2, $3, $4, $5, 'guided_rules', $6)
          ON CONFLICT (id) DO NOTHING
        `, [revisionId, id, item.dsl.name, "平台受限 DSL V3 迁移版本", specificationJson, authorUserId]);
        await client.query(`
          INSERT INTO platform_strategy_migration_map (
            strategy_code, symbol, strategy_id, strategy_version_id, conversion_contract_sha256
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (strategy_code, symbol) DO UPDATE
          SET strategy_id = EXCLUDED.strategy_id,
              strategy_version_id = EXCLUDED.strategy_version_id,
              conversion_contract_sha256 = EXCLUDED.conversion_contract_sha256
        `, [item.code, item.symbol, id, revisionId, contractHash]);
      }

      const legacy = await client.query(`
        SELECT subscription.*,
          decision.symbol AS latest_symbol
        FROM platform_strategy_subscriptions AS subscription
        LEFT JOIN LATERAL (
          SELECT symbol FROM platform_decisions
          WHERE customer_id = subscription.customer_id
            AND strategy_code = subscription.strategy_code
          ORDER BY updated_at DESC, id DESC LIMIT 1
        ) AS decision ON true
        ORDER BY subscription.created_at, subscription.id
      `);
      let migrated = 0;
      for (const row of legacy.rows) {
        const candidates = definitions.filter(item => item.code === row.strategy_code);
        if (!candidates.length) throw new Error(`cutover blocked: unknown legacy strategy ${row.strategy_code}`);
        const selected = candidates.find(item => item.symbol === row.latest_symbol) || candidates[0];
        const selectionSource = selected.symbol === row.latest_symbol ? "latest_audited_decision" : "platform_primary_symbol";
        const existingMigration = await client.query(`
          SELECT * FROM platform_subscription_migrations WHERE legacy_subscription_id = $1
        `, [row.id]);
        if (existingMigration.rows[0]) {
          if (existingMigration.rows[0].conversion_contract_sha256 !== contractHash) {
            throw new Error(`cutover blocked: legacy subscription ${row.id} used a different conversion contract`);
          }
          continue;
        }
        const mappedStrategyId = strategyId(selected.code, selected.symbol);
        const mappedVersionId = versionId(selected.code, selected.symbol);
        const membership = (await client.query(`
          SELECT id FROM memberships
          WHERE customer_id = $1 AND status IN ('active', 'grace')
          ORDER BY created_at DESC, id DESC LIMIT 1
        `, [row.customer_id])).rows[0];
        if (!membership) throw new Error(`cutover blocked: active membership missing for ${row.id}`);
        const portfolios = await ensureOfficialPaperPortfolios(client, {
          membershipId: membership.id,
          customerId: row.customer_id,
        });
        const portfolio = portfolios.find(item => item.strategyCode === selected.code);
        if (!portfolio) throw new Error(`cutover blocked: official paper portfolio missing for ${row.id}`);
        let unifiedSubscriptionId = subscriptionId(row.id);
        const collision = await client.query(`
          SELECT id FROM strategy_subscriptions WHERE strategy_id = $1 AND customer_id = $2 LIMIT 1
        `, [mappedStrategyId, row.customer_id]);
        if (collision.rows[0]) {
          unifiedSubscriptionId = collision.rows[0].id;
          await client.query(`
            UPDATE strategy_subscriptions
            SET exchange_account_id = NULL,
                capital_pct = $2,
                stop_loss_pct = 0,
                strategy_version_id = $3,
                run_mode = $4,
                risk_check_json = $5::jsonb,
                updated_at = now()
            WHERE id = $1
          `, [unifiedSubscriptionId, selected.dsl.risk.maxAssetAllocationPct, mappedVersionId, mode,
            JSON.stringify({ product: "spot_usdt", risk: selected.dsl.risk, customerExchangeAccountUsed: false })]);
        }
        else await client.query(`
          INSERT INTO strategy_subscriptions (
            id, strategy_id, customer_id, exchange_account_id, capital_pct, stop_loss_pct,
            execution_mode, status, risk_consent_at, last_risk_check_at, risk_check_json,
            started_at, ended_at, strategy_version_id, run_mode, runtime_status
          ) VALUES ($1, $2, $3, $4, $5, $6, 'proportional', $7, $8, $9, $10, $11, $12, $13, $14, $7)
        `, [
          unifiedSubscriptionId, mappedStrategyId, row.customer_id, null,
          selected.dsl.risk.maxAssetAllocationPct, 0, row.status, row.risk_consent_at,
          row.last_risk_check_at, JSON.stringify({ product: "spot_usdt", risk: selected.dsl.risk, customerExchangeAccountUsed: false }), row.started_at, row.ended_at,
          mappedVersionId, mode,
        ]);
        let runtimeDeploymentId = null;
        if (row.status !== "ended") {
          runtimeDeploymentId = deploymentId(row.id);
          await client.query(`
            INSERT INTO strategy_deployments (
              id, owner_user_id, strategy_id, strategy_version_id, strategy_subscription_id,
              exchange_account_id, mode, status, validation_label, unverified_warning,
              position_size_pct, stop_loss_pct_override, idempotency_key, risk_acknowledged_at,
              execution_product, platform_strategy_code, membership_id, paper_portfolio_id
            ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, 'UNVERIFIED', true, NULL, NULL, $8, now(),
                      'spot_usdt', $9, $10, $11)
            ON CONFLICT (owner_user_id, idempotency_key) DO UPDATE SET
              strategy_version_id = EXCLUDED.strategy_version_id,
              exchange_account_id = NULL,
              execution_product = 'spot_usdt',
              platform_strategy_code = EXCLUDED.platform_strategy_code,
              membership_id = EXCLUDED.membership_id,
              paper_portfolio_id = EXCLUDED.paper_portfolio_id,
              updated_at = now()
          `, [
            runtimeDeploymentId, row.customer_id, mappedStrategyId, mappedVersionId,
            unifiedSubscriptionId, mode,
            row.status === "active" ? "active" : "paused",
            `legacy-platform-subscription:${row.id}`, selected.code, membership.id, portfolio.id,
          ]);
        }
        await client.query(`
          INSERT INTO platform_subscription_migrations (
            legacy_subscription_id, strategy_subscription_id, deployment_id,
            selected_symbol, selection_source, conversion_contract_sha256,
            legacy_read_only_until
          ) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '14 days')
        `, [row.id, unifiedSubscriptionId, runtimeDeploymentId, selected.symbol, selectionSource, contractHash]);
        migrated += 1;
      }
      await client.query(`
        INSERT INTO platform_runtime_cutovers (
          id, conversion_contract_sha256, deployment_mode,
          migrated_subscription_count, legacy_read_only_until
        ) VALUES ($1, $2, $3, $4, now() + interval '14 days')
      `, [crypto.randomUUID(), contractHash, mode, migrated]);
      await client.query("COMMIT");
      process.stdout.write(`${JSON.stringify({ ...report, migratedSubscriptionCount: migrated }, null, 2)}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
