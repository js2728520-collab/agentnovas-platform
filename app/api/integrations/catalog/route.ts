import {
  INTEGRATION_CATALOG,
  INTEGRATION_CATEGORY_LABELS,
} from "@/lib/integration-catalog";

function configured(keys: string[]) {
  return keys.some((key) => Boolean(process.env[key]));
}

export async function GET() {
  return Response.json({
    categories: INTEGRATION_CATEGORY_LABELS,
    integrations: INTEGRATION_CATALOG.map((item) => ({
      ...item,
      configured: configured(item.envKeys),
    })),
    note: "免费额度和公共接口均受供应商限流、地区及服务条款约束；密钥只应配置在服务端变量和机密中。",
    updatedAt: new Date().toISOString(),
  }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
