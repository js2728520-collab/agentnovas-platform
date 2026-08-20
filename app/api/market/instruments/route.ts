import { marketInstruments } from "@/lib/market-instruments";

export async function GET() { return Response.json({ instruments: marketInstruments, updatedAt: new Date().toISOString(), source: "Riverton Capital market catalog" }, { headers: { "cache-control": "no-store" } }); }
