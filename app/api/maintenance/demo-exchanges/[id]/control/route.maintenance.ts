import {
  requireAccessPermission,
  requireAnyAccessPermission,
} from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import {
  claimPlatformDemoAdminCommand,
  completePlatformDemoAdminCommand,
  completedPlatformDemoCommandResponse,
} from "@/lib/platform-demo-admin-commands";
import { idempotencyKey } from "@/lib/commercial-api";
import { automaticAuditReason, maintenanceCorrelation } from "@/lib/maintenance-audit";
import {
  readResearchJson,
  ResearchApiError,
  researchErrorResponse,
} from "@/lib/research-api";

const accountActions = ["enable", "disable", "kill", "resume"] as const;
const cardActions = ["card_kill", "card_resume"] as const;
type ControlAction =
  | (typeof accountActions)[number]
  | (typeof cardActions)[number];

function controlInput(body: Record<string, unknown>) {
  const action = String(body.action ?? "") as ControlAction;
  if (![...accountActions, ...cardActions].includes(action)) {
    throw new ResearchApiError("VALIDATION_ERROR", "action 无效", 422, {
      fields: ["action"],
    });
  }
  const strategyCode =
    typeof body.strategyCode === "string" ? body.strategyCode.trim() : "";
  if (
    cardActions.includes(action as (typeof cardActions)[number]) &&
    !["ai_conservative", "ai_balanced", "ai_aggressive"].includes(strategyCode)
  ) {
    throw new ResearchApiError("VALIDATION_ERROR", "strategyCode 无效", 422, {
      fields: ["strategyCode"],
    });
  }
  return {
    action,
    reason: automaticAuditReason(`maintenance.demo.${action}`),
    strategyCode: strategyCode || null,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAnyAccessPermission(request, [
      "maint.demo_exchanges.manage",
      "maint.demo_exchanges.kill",
    ]);
    const input = controlInput(await readResearchJson(request, 4_096));
    const isKill = ["disable", "kill", "card_kill"].includes(input.action);
    const { user } = await requireAccessPermission(
      request,
      isKill ? "maint.demo_exchanges.kill" : "maint.demo_exchanges.manage",
    );
    const { id } = await params;
    const commandKey = idempotencyKey(request);
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const account = (
        await client.query<{
          id: string;
          provider: string;
          enabled: boolean;
          kill_switch_enabled: boolean;
          has_api_key: boolean;
          has_secret: boolean;
          last_verified_at: Date | null;
          last_verification_status: string | null;
        }>(
          `SELECT id,provider,enabled,kill_switch_enabled,has_api_key,has_secret,
                  last_verified_at,last_verification_status
           FROM platform_demo_accounts_safe
           WHERE id=$1
           FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!account) {
        throw new ResearchApiError("DEMO_ACCOUNT_NOT_FOUND", "Demo 账户不存在", 404);
      }
      const claim = await claimPlatformDemoAdminCommand(client, {
        operation: "control",
        idempotencyKey: commandKey,
        actorUserId: user.id,
        accountId: account.id,
        action: input.action,
        strategyCode: input.strategyCode,
        reason: input.reason,
        ...maintenanceCorrelation(request),
      });
      const replay = completedPlatformDemoCommandResponse(claim);
      if (replay) {
        await client.query("COMMIT");
        return Response.json(replay);
      }
      let changed = false;
      if (input.action === "enable") {
        if (account.kill_switch_enabled) {
          throw new ResearchApiError(
            "DEMO_KILL_SWITCH_ACTIVE",
            "Demo kill switch 仍在生效；请先单独恢复停控并重新核对状态",
            409,
          );
        }
        const verificationFresh =
          account.last_verification_status === "passed" &&
          Boolean(account.last_verified_at) &&
          account.last_verified_at!.getTime() >= Date.now() - 15 * 60_000;
        if (!account.has_api_key || !account.has_secret || !verificationFresh) {
          throw new ResearchApiError(
            "DEMO_ACCOUNT_NOT_READY",
            "账户未完整配置或缺少 15 分钟内的成功验证",
            409,
          );
        }
        const result = await client.query(
          `UPDATE platform_demo_accounts
           SET enabled=true,updated_by=$2,updated_at=now()
           WHERE id=$1 AND kill_switch_enabled=false AND enabled IS DISTINCT FROM true`,
          [id, user.id],
        );
        changed = result.rowCount === 1;
      } else if (input.action === "disable") {
        const result = await client.query(
          `UPDATE platform_demo_accounts
           SET enabled=false,updated_by=$2,updated_at=now()
           WHERE id=$1 AND enabled IS DISTINCT FROM false`,
          [id, user.id],
        );
        changed = result.rowCount === 1;
      } else if (input.action === "kill") {
        const result = await client.query(
          `UPDATE platform_demo_accounts
           SET enabled=false,kill_switch_enabled=true,updated_by=$2,updated_at=now()
           WHERE id=$1 AND (enabled IS DISTINCT FROM false OR kill_switch_enabled IS DISTINCT FROM true)`,
          [id, user.id],
        );
        changed = result.rowCount === 1;
      } else if (input.action === "resume") {
        const result = await client.query(
          `UPDATE platform_demo_accounts
           SET kill_switch_enabled=false,updated_by=$2,updated_at=now()
           WHERE id=$1 AND kill_switch_enabled IS DISTINCT FROM false`,
          [id, user.id],
        );
        changed = result.rowCount === 1;
      } else {
        const killSwitchEnabled = input.action === "card_kill";
        const result = await client.query(
          `INSERT INTO platform_demo_card_controls
             (provider,strategy_code,kill_switch_enabled,updated_by,updated_at)
           VALUES($1,$2,$3,$4,now())
           ON CONFLICT(provider,strategy_code) DO UPDATE
           SET kill_switch_enabled=EXCLUDED.kill_switch_enabled,
               updated_by=EXCLUDED.updated_by,updated_at=now()
           WHERE platform_demo_card_controls.kill_switch_enabled
                 IS DISTINCT FROM EXCLUDED.kill_switch_enabled`,
          [account.provider, input.strategyCode, killSwitchEnabled, user.id],
        );
        changed = result.rowCount === 1;
      }
      const response = {
        ok: true,
        accountId: account.id,
        provider: account.provider,
        action: input.action,
        strategyCode: input.strategyCode,
        result: changed ? "CONTROL_RECORDED" : "NO_CHANGE",
      };
      await completePlatformDemoAdminCommand(client, {
        id: claim.id,
        status: "succeeded",
        response,
      });
      await client.query("COMMIT");
      return Response.json(response);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
