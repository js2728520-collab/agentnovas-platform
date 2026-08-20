import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireUser, responseError } from "@/lib/session";
import { isCustomerTradingEmergencyStopped } from "@/lib/trading-emergency";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const me = await requireUser(request, ["customer"]);
    if (await isCustomerTradingEmergencyStopped(me.id)) {
      return Response.json({ error: "当前所属范围处于紧急停止状态，暂不能开启策略跟随" }, { status: 503 });
    }
    return Response.json({ error: "实盘跟单尚未开放；客户策略请先使用历史回测和作者模拟测试" }, { status: 403 });
  } catch (error) {
    return responseError(error);
  }
}
