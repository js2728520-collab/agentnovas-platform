import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireUser, responseError } from "@/lib/session";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireUser(request, ["customer"]);
    return Response.json({ error: "实盘跟单尚未开放；客户策略请先使用历史回测和作者模拟测试" }, { status: 403 });
  } catch (error) {
    return responseError(error);
  }
}
