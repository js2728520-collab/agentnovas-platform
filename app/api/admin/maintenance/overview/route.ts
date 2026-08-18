import { desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { approvalRequests, auditLogs, communityStrategies, llmConfigurations, organizations, sessions, trades, users } from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { getPlatformSetting } from "@/lib/platform-settings";
import { runtimeSetting } from "@/lib/runtime-setting";
import { requireUser, responseError } from "@/lib/session";

const total = (value: unknown) => Number(value || 0);

export async function GET(request: Request) {
  try {
    await ensureD1Schema();
    await requireUser(request, ["hq_admin"]);
    const db = getDb();
    const now = new Date().toISOString();
    const [userCount, organizationCount, activeSessionCount, pendingApprovalCount, pendingStrategyCount, tradeCount, auditCount, recentAudit, llm, integrations, security] = await Promise.all([
      db.select({ value: sql<number>`count(*)` }).from(users),
      db.select({ value: sql<number>`count(*)` }).from(organizations),
      db.select({ value: sql<number>`count(*)` }).from(sessions).where(sql`${sessions.expiresAt} > ${now} and ${sessions.revokedAt} is null`),
      db.select({ value: sql<number>`count(*)` }).from(approvalRequests).where(eq(approvalRequests.status, "pending")),
      db.select({ value: sql<number>`count(*)` }).from(communityStrategies).where(eq(communityStrategies.status, "submitted")),
      db.select({ value: sql<number>`count(*)` }).from(trades),
      db.select({ value: sql<number>`count(*)` }).from(auditLogs),
      db.select({ id: auditLogs.id, actorUserId: auditLogs.actorUserId, action: auditLogs.action, subjectType: auditLogs.subjectType, subjectId: auditLogs.subjectId, createdAt: auditLogs.createdAt, ipAddress: auditLogs.ipAddress }).from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(20),
      db.select({ providerName: llmConfigurations.providerName, model: llmConfigurations.model, enabled: llmConfigurations.enabled, hasKey: sql<number>`case when length(${llmConfigurations.encryptedApiKey}) > 0 then 1 else 0 end`, updatedAt: llmConfigurations.updatedAt }).from(llmConfigurations).where(eq(llmConfigurations.id, "system-default")).limit(1),
      getPlatformSetting("integrations"),
      getPlatformSetting("security"),
    ]);
    const runtimeChecks = {
      database: true,
      credentialEncryption: Boolean(runtimeSetting("EXCHANGE_CREDENTIAL_ENCRYPTION_KEY") && runtimeSetting("EXCHANGE_CREDENTIAL_ENCRYPTION_KEY")!.length >= 32),
      automationSecret: Boolean(runtimeSetting("AUTOMATION_INTERNAL_SECRET") && runtimeSetting("AUTOMATION_INTERNAL_SECRET")!.length >= 24),
      systemLlm: Boolean(llm[0]?.enabled && llm[0]?.hasKey) || Boolean(runtimeSetting("AI_API_URL") && runtimeSetting("AI_API_KEY") && runtimeSetting("AI_MODEL")),
      emergencyStop: security.emergencyStop || runtimeSetting("PLATFORM_EMERGENCY_STOP") === "true",
    };
    return Response.json({
      generatedAt: now,
      counts: {
        users: total(userCount[0]?.value), organizations: total(organizationCount[0]?.value), activeSessions: total(activeSessionCount[0]?.value),
        pendingApprovals: total(pendingApprovalCount[0]?.value), pendingStrategies: total(pendingStrategyCount[0]?.value), trades: total(tradeCount[0]?.value), auditLogs: total(auditCount[0]?.value),
      },
      runtimeChecks,
      integrations: { ...integrations, llm: llm[0] || null },
      recentAudit,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return responseError(error); }
}
