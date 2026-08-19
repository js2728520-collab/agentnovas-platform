import { APP_DEFINITIONS } from "@/lib/riverton-apps";
import { DATA_SCOPES, PERMISSION_DEFINITIONS } from "@/lib/rbac";

export async function GET() {
  return Response.json({
    applications: APP_DEFINITIONS.map((app) => ({
      id: app.id,
      name: app.name,
      domain: app.domain,
      localPort: app.localPort,
      description: app.description,
    })),
    dataScopes: DATA_SCOPES,
    permissions: PERMISSION_DEFINITIONS.map((permission) => ({
      key: permission.key,
      appId: permission.appId,
      label: permission.label,
      sensitive: Boolean(permission.sensitive),
    })),
  }, {
    headers: { "cache-control": "no-store" },
  });
}

