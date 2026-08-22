import { requireUser, responseError } from "@/lib/session";

export async function GET(request: Request) {
  try {
    await requireUser(request, ["customer"]);
    return Response.json({
      executionIp: process.env.EXECUTION_SERVER_IP || "部署后由服务端配置",
      configured: Boolean(process.env.EXECUTION_SERVER_IP),
      note: "白名单地址必须来自部署环境的固定出口 IP；本地开发环境不提供生产白名单地址。",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}
