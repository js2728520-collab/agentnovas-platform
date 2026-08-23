import { requireAccessPermission } from "@/lib/access-control";
import {
  issueInternalRegistrationLink,
  listInternalRegistrationLinks,
  recordInternalRegistrationLinkCopied,
  revokeInternalRegistrationLink,
} from "@/lib/internal-registration-link-service";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { responseError } from "@/lib/session";
import { invitableInternalRoles } from "@/packages/domain/src/organization-provisioning";

function registrationUrl(request: Request, token: string) {
  const base = process.env.OPERATIONS_PUBLIC_BASE_URL?.trim() || new URL(request.url).origin;
  const url = new URL("/login", base);
  url.hash = new URLSearchParams({ "staff-invite": token, app: "operations" }).toString();
  return url.toString();
}

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.invitations.view");
    const pool = await getPostgresPool();
    const [links, organizationResult] = await Promise.all([
      listInternalRegistrationLinks(pool, user.id),
      user.role === "hq_admin"
        ? pool.query<{ id: string; name: string }>(`
            SELECT id,name FROM organizations
             WHERE type='branch' AND status='active'
             ORDER BY name,id
             LIMIT 500
          `)
        : Promise.resolve({ rows: [] as Array<{ id: string; name: string }> }),
    ]);
    return Response.json({
      links,
      invitableRoles: invitableInternalRoles(user.role),
      organizations: organizationResult.rows,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.invitations.manage");
    const body = await readResearchJson(request, 4_096);
    const targetRole = typeof body.targetRole === "string" ? body.targetRole : "";
    const targetOrganizationId = typeof body.organizationId === "string" && body.organizationId.trim()
      ? body.organizationId.trim()
      : null;
    if (!targetRole) {
      throw new ResearchApiError("TARGET_ROLE_REQUIRED", "请选择要授予的角色", 400);
    }
    const issued = await issueInternalRegistrationLink(await getPostgresPool(), {
      issuerUserId: user.id,
      issuerRole: user.role,
      issuerOrganizationId: user.organizationId,
      targetRole,
      targetOrganizationId,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
    });
    return Response.json({
      link: registrationUrl(request, issued.token),
      registrationLink: {
        id: issued.id,
        targetRole: issued.targetRole,
        organizationMode: issued.organizationMode,
        organizationId: issued.organizationId,
        permissionSnapshot: issued.permissionSnapshot,
        status: issued.status,
        expiresAt: null,
        createdAt: issued.createdAt,
      },
      replacedPreviousLink: issued.replacedLinkIds.length > 0,
      warning: "链接明文仅本次显示。链接长期有效且可重复注册；手动作废或重新生成后，旧链接立即失效。",
    }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.invitations.manage");
    const body = await readResearchJson(request, 2_048);
    const linkId = typeof body.linkId === "string" ? body.linkId.trim() : "";
    if (!linkId) throw new ResearchApiError("LINK_ID_REQUIRED", "缺少注册链接标识", 400);
    const result = await revokeInternalRegistrationLink(await getPostgresPool(), {
      linkId,
      actorUserId: user.id,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.invitations.manage");
    const body = await readResearchJson(request, 2_048);
    const linkId = typeof body.linkId === "string" ? body.linkId.trim() : "";
    if (!linkId || body.action !== "copied") {
      throw new ResearchApiError("COPY_EVENT_INVALID", "复制事件参数无效", 400);
    }
    const result = await recordInternalRegistrationLinkCopied(await getPostgresPool(), {
      linkId,
      actorUserId: user.id,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}
