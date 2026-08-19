import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions } from "@/db/schema";
import { sha256 } from "@/lib/auth";
import { clearSessionCookieHeaders, cookieNamesForRequest } from "@/lib/riverton-apps";
export async function POST(request: Request) { const names=cookieNamesForRequest(request).names; const token=(request.headers.get("cookie")??"").split(";").map(x=>x.trim()).find(x=>names.some(name=>x.startsWith(`${name}=`)))?.split("=")[1]; if(token)await getDb().update(sessions).set({revokedAt:new Date().toISOString()}).where(eq(sessions.tokenHash,await sha256(decodeURIComponent(token)))); const headers=new Headers({"content-type":"application/json"}); for(const cookie of clearSessionCookieHeaders(request))headers.append("set-cookie",cookie); return new Response(JSON.stringify({ok:true}),{headers}); }
