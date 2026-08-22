import { requireAccessPermission } from "@/lib/access-control";
import {
  loadMaintenanceDemoSafeView,
} from "@/lib/maintenance-demo-view";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.demo_exchanges.view");
    const accounts = await loadMaintenanceDemoSafeView(await getPostgresPool());
    return Response.json(
      {
        checkedAt: new Date().toISOString(),
        executionPolicy: {
          quoteAmountUsdt: "10",
          providerDailyCapUsdt: "100",
          livePerpetualOrders: false,
        },
        accounts,
      },
      { headers: { "cache-control": "no-store, max-age=0" } },
    );
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
