import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { users } from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { requireUser, responseError } from "@/lib/session";

export async function POST(request: Request) {
  try {
    await ensureD1Schema();
    const current = await requireUser(request);
    const input = await request.json() as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = String(input.currentPassword ?? "");
    const newPassword = String(input.newPassword ?? "");
    if (!(await verifyPassword(currentPassword, current.passwordHash))) return Response.json({ error: "当前密码不正确" }, { status: 400 });
    if (newPassword === currentPassword) return Response.json({ error: "新密码不能与当前密码相同" }, { status: 400 });
    const passwordHash = await hashPassword(newPassword);
    await getDb().update(users).set({ passwordHash, updatedAt: new Date().toISOString() }).where(eq(users.id, current.id));
    return Response.json({ ok: true });
  } catch (error) { return responseError(error); }
}
