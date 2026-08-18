import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, platformFollowPolicies } from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireUser, responseError } from "@/lib/session";

const POLICY_ID = "default";

async function readPolicy() {
  const db = getDb();
  let policy = (await db.select().from(platformFollowPolicies).where(eq(platformFollowPolicies.id, POLICY_ID)).limit(1))[0];
  if (!policy) {
    await db.insert(platformFollowPolicies).values({ id: POLICY_ID, allowFollowWithoutWithdrawal: false });
    policy = (await db.select().from(platformFollowPolicies).where(eq(platformFollowPolicies.id, POLICY_ID)).limit(1))[0];
  }
  return policy;
}

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireUser(request, ["hq_admin"]);
    const policy = await readPolicy();
    return Response.json({
      policy: {
        allowFollowWithoutWithdrawal: Boolean(policy?.allowFollowWithoutWithdrawal),
        manualCollectionRequired: Boolean(policy?.allowFollowWithoutWithdrawal),
        updatedAt: policy?.updatedAt || null,
      },
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabaseSchema();
    const user = await requireUser(request, ["hq_admin"]);
    const body = await request.json() as { allowFollowWithoutWithdrawal?: boolean };
    const allowFollowWithoutWithdrawal = body.allowFollowWithoutWithdrawal === true;
    const db = getDb();
    const before = await readPolicy();
    const now = new Date().toISOString();
    if (before) {
      await db.update(platformFollowPolicies).set({
        allowFollowWithoutWithdrawal,
        updatedByUserId: user.id,
        updatedAt: now,
      }).where(eq(platformFollowPolicies.id, POLICY_ID));
    } else {
      await db.insert(platformFollowPolicies).values({
        id: POLICY_ID,
        allowFollowWithoutWithdrawal,
        updatedByUserId: user.id,
        updatedAt: now,
      });
    }
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: user.id,
      action: "platform.follow_policy.updated",
      subjectType: "platform_follow_policy",
      subjectId: POLICY_ID,
      beforeJson: JSON.stringify({ allowFollowWithoutWithdrawal: Boolean(before?.allowFollowWithoutWithdrawal) }),
      afterJson: JSON.stringify({ allowFollowWithoutWithdrawal }),
    });
    return Response.json({
      ok: true,
      policy: { allowFollowWithoutWithdrawal, manualCollectionRequired: allowFollowWithoutWithdrawal, updatedAt: now },
      message: "策略跟随权限规则已保存",
    });
  } catch (error) {
    return responseError(error);
  }
}
