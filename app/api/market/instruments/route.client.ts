import { createMarketInstrumentsPayload } from "@/lib/market-catalog";

export async function GET() {
  return Response.json(createMarketInstrumentsPayload(new Date().toISOString()), {
    headers: { "cache-control": "no-store" },
  });
}
