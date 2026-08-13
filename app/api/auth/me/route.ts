import { currentUser } from "@/lib/session";
export async function GET(request: Request) { const user = await currentUser(request); return Response.json({ user: user ? { id: user.id, email: user.email, role: user.role, organizationId: user.organizationId, locale: user.locale, timezone: user.timezone } : null }); }
