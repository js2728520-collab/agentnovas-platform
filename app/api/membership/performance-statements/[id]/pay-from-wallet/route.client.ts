import { requireAccessPermission } from "@/lib/access-control";
import { responseError } from "@/lib/session";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { payPerformanceStatementFromWallet } from "@/lib/performance-fee-wallet-payment";

/**
 * 用钱包余额支付绩效分成账单。
 *
 * 与会员那条同源：钱包里的钱已经在系统里，进来时走过一次充值的双人复核，
 * 再要求第二个人批准「客户花自己的钱」是没有对应风险的摩擦。
 *
 * 但这条多做一件事——**推进高水位线**。付了款却不推进，客户会被就同一段盈利重复
 * 收费；推进了却没收到款，平台白白放弃这一段的收费权。两者在服务层的同一个事务里。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user: me } = await requireAccessPermission(request, "client.membership.order");
    const { id } = await context.params;
    const body = await readResearchJson(request, 1_024);
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new ResearchApiError("IDEMPOTENCY_KEY_INVALID", "缺少有效的幂等键", 400);
    }

    const result = await payPerformanceStatementFromWallet(await getPostgresPool(), {
      statementId: id,
      userId: me.id,
      idempotencyKey,
      requestId: crypto.randomUUID(),
    });
    return Response.json({ ...result, message: "分成账单已结清，费用从钱包余额扣除。" });
  } catch (error) {
    return responseError(error);
  }
}
