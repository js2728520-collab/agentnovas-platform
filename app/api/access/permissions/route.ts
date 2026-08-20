import { requireCurrentAccessViewer } from "@/lib/access-control";
import { APP_DEFINITIONS } from "@/lib/riverton-apps";
import { DATA_SCOPES, PERMISSION_DEFINITIONS } from "@/lib/rbac";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { appId } = await requireCurrentAccessViewer(request);
    return Response.json({
    applications: APP_DEFINITIONS.filter((app) => app.id === appId).map((app) => ({
      id: app.id,
      name: app.name,
      domain: app.domain,
      localPort: app.localPort,
      description: app.description,
    })),
    dataScopes: DATA_SCOPES,
    permissions: PERMISSION_DEFINITIONS.filter((permission) => permission.appId === appId).map((permission) => ({
      key: permission.key,
      appId: permission.appId,
      label: permission.label,
      sensitive: Boolean(permission.sensitive),
    })),
  }, {
    headers: { "cache-control": "no-store" },
  });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
