import { requireAccessPermission } from "@/lib/access-control";
import { responseError } from "@/lib/session";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { payMembershipOrderFromWallet } from "@/lib/membership-wallet-payment";

/**
 * 用钱包余额支付会员订单。
 *
 * 客户自助、即时生效——刻意不走 maker/checker。那套流程为**站外付款**而设：运营录
 * 凭证、第二个人核对，因为钱从系统外面进来，没人能自动确认它真的到了。钱包里的钱
 * 已经在系统里，而且它进来时就走过一次充值的双人复核。再要求第二个人批准「客户花
 * 自己的钱」，是没有对应风险的摩擦。
 *
 * 余额不足返回 402，前端据此提示去充值——用 400 会和参数错误混在一起。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    // 与同级的下单接口用同一个权限键：付款和下单是同一件事的两半。
    // 它标了 sensitive，因此强制近期 MFA——支付路径正需要。
    const { user: me } = await requireAccessPermission(request, "client.membership.order");
    const { id } = await context.params;
    const body = await readResearchJson(request, 1_024);
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    // 幂等键由客户端生成并必填：网络重试在支付路径上是常态，
    // 没有它同一次点击可能扣两次。
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new ResearchApiError("IDEMPOTENCY_KEY_INVALID", "缺少有效的幂等键", 400);
    }

    const result = await payMembershipOrderFromWallet(await getPostgresPool(), {
      orderId: id,
      userId: me.id,
      idempotencyKey,
      requestId: crypto.randomUUID(),
    });
    return Response.json({
      ...result,
      message: "会员已开通，费用从钱包余额扣除。",
    });
  } catch (error) {
    return responseError(error);
  }
}
