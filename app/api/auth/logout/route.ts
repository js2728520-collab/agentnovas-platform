import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions } from "@/db/schema";
import { sha256 } from "@/lib/auth";
export async function POST(request: Request) { const token=(request.headers.get("cookie")??"").split(";").map(x=>x.trim()).find(x=>x.startsWith("an_session="))?.slice(11); if(token)await getDb().update(sessions).set({revokedAt:new Date().toISOString()}).where(eq(sessions.tokenHash,await sha256(decodeURIComponent(token)))); return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json","set-cookie":"an_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"}}); }
