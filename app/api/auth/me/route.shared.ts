import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { memberships } from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { resolveAppAudienceStrict } from "@/lib/riverton-apps";
import { currentUser } from "@/lib/session";

export async function GET(request: Request) {
  await ensureDatabaseSchema();
  const user = await currentUser(request);
  // 会员是客户侧的概念，只在客户端解析。
  //
  // 这个路由三端共用，原来无条件查 memberships——而运维端的数据库角色没有这张表的
  // 权限（运维端不该看客户商业数据）。于是运维端每次拉会话都 42501，表现是
  // **输完 MFA 验证码跳回登录页**：验证其实成功了，是紧接着的会话加载炸了，
  // 被上层当成未登录。
  //
  // 修法不是给运维端开 memberships 的读权限——那是为了修一个查询而扩大运维端对
  // 客户商业数据的可见范围。按 audience 收窄才是对的。
  const audience = resolveAppAudienceStrict({ host: request.headers.get("host") ?? undefined });
  const membership = user && audience === "client"
    ? (await getDb().select({ planCode: memberships.planCode, status: memberships.status, expiresAt: memberships.expiresAt }).from(memberships).where(eq(memberships.customerId, user.id)).orderBy(desc(memberships.createdAt)).limit(1))[0] ?? null
    : null;
  return Response.json({ user: user ? { id: user.id, email: user.email, username: user.username, nickname: user.nickname, avatarUrl: user.avatarUrl, phone: user.phone, dateOfBirth: user.dateOfBirth, gender: user.gender, role: user.role, organizationId: user.organizationId, locale: user.locale, timezone: user.timezone, membership } : null });
}
