import { publicMarketSourcesForClient } from "@/lib/market-sources";
import { listMarketSourceSelection } from "@/lib/market-source-selection";

export async function GET(request: Request) {
  const selection = await listMarketSourceSelection(request);
  return Response.json({
    sources: publicMarketSourcesForClient(),
    configured: selection.configured,
    selected: selection.source.key,
    selectionMode: selection.mode,
    defaultSource: selection.mode === "default" ? selection.source.key : "COINBASE",
    updatedAt: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
