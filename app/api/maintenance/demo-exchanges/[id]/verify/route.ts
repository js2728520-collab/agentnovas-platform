import { requireAccessPermission } from "@/lib/access-control";
import { verifyPlatformDemoAccount } from "@/lib/platform-demo-execution";
import { getPostgresPool } from "@/lib/postgres";
import { idempotencyKey } from "@/lib/commercial-api";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import {
  claimPlatformDemoAdminCommand,
  completePlatformDemoAdminCommand,
  completedPlatformDemoCommandResponse,
} from "@/lib/platform-demo-admin-commands";
import {
  readResearchJson,
  ResearchApiError,
  researchErrorResponse,
} from "@/lib/research-api";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAccessPermission(
      request,
      "maint.demo_exchanges.verify",
    );
    if (process.env.PLATFORM_DEMO_VERIFICATION_ENABLED !== "true") {
      throw new ResearchApiError(
        "DEMO_VERIFICATION_DISABLED",
        "Demo provider 连通验证未获环境授权，未发起外部请求",
        503,
      );
    }
    const body = await readResearchJson(request, 4_096);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 8 || reason.length > 500) {
      throw new ResearchApiError("VALIDATION_ERROR", "reason 需为 8 到 500 个字符", 422, {
        fields: ["reason"],
      });
    }
    const { id } = await params;
    const commandKey = idempotencyKey(request);
    const pool = await getPostgresPool();
    const client = await pool.connect();
    let commandId = "";
    try {
      await client.query("BEGIN");
      const account = await client.query(
        "SELECT id FROM platform_demo_accounts WHERE id=$1 FOR SHARE",
        [id],
      );
      if (account.rowCount !== 1) {
        throw new ResearchApiError(
          "DEMO_ACCOUNT_NOT_FOUND",
          "Demo 账户不存在",
          404,
        );
      }
      const claim = await claimPlatformDemoAdminCommand(client, {
        operation: "verify",
        idempotencyKey: commandKey,
        actorUserId: user.id,
        accountId: id,
        action: "verify",
        strategyCode: null,
        reason,
        ...maintenanceCorrelation(request),
      });
      const replay = completedPlatformDemoCommandResponse(claim);
      commandId = claim.id;
      await client.query("COMMIT");
      if (replay) return Response.json(replay);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    try {
      const result = await verifyPlatformDemoAccount(pool, {
        accountId: id,
        actorId: user.id,
      });
      const response = {
        ok: true,
        accountId: result.accountId,
        provider: result.provider,
        status: result.status,
        verifiedAt: result.verifiedAt,
        permissionCheck: result.permissionCheck,
      };
      const completion = await pool.connect();
      try {
        await completion.query("BEGIN");
        await completePlatformDemoAdminCommand(completion, {
          id: commandId,
          status: "succeeded",
          response,
        });
        await completion.query("COMMIT");
      } catch (error) {
        await completion.query("ROLLBACK");
        throw error;
      } finally {
        completion.release();
      }
      return Response.json(response);
    } catch (error) {
      if (commandId) {
        const completion = await pool.connect();
        try {
          await completion.query("BEGIN");
          await completePlatformDemoAdminCommand(completion, {
            id: commandId,
            status: "failed",
            errorCode:
              error instanceof ResearchApiError
                ? error.code
                : "DEMO_VERIFICATION_FAILED",
          });
          await completion.query("COMMIT");
        } catch {
          await completion.query("ROLLBACK");
        } finally {
          completion.release();
        }
      }
      throw error;
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
