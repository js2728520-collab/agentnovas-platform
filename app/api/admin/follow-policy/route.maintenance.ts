import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, platformFollowPolicies } from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireAccessPermission } from "@/lib/access-control";
import { responseError } from "@/lib/session";

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
    await requireAccessPermission(request, "maint.follow_policy.view");
    const policy = await readPolicy();
    return Response.json({
      policy: {
        // 提现授权已不再是可选项：平台永不持有提现权限（迁移 0045）。
        // 因此「允许未开启提现授权的账户跟随」恒为真，分成恒走人工复核收款。
        allowFollowWithoutWithdrawal: true,
        manualCollectionRequired: true,
        withdrawalAuthorityAccepted: false,
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
    const { user } = await requireAccessPermission(request, "maint.follow_policy.manage");
    const body = await request.json() as { allowFollowWithoutWithdrawal?: boolean };
    // 唯一合法取值是 true。false 意味着「要求客户开通提现授权才能跟单」——
    // 那条路径已被产品决策废止，平台不接收带提现权限的凭证（迁移 0045 有约束兜底）。
    if (body.allowFollowWithoutWithdrawal === false) {
      return Response.json({
        code: "WITHDRAWAL_AUTHORITY_FORBIDDEN",
        error: "平台永不持有提现权限，无法恢复「要求提现授权」的跟单策略。绩效分成从预充服务余额扣除。",
      }, { status: 400 });
    }
    const allowFollowWithoutWithdrawal = true;
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
      policy: {
        allowFollowWithoutWithdrawal,
        manualCollectionRequired: true,
        withdrawalAuthorityAccepted: false,
        updatedAt: now,
      },
      message: "策略跟随权限规则已保存",
    });
  } catch (error) {
    return responseError(error);
  }
}
