import { notFound } from "next/navigation";

import { RivertonRoute } from "../riverton-route";

export default async function StableRivertonPage({
  params,
  searchParams,
}: {
  params: Promise<{ segments: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { segments } = await params;
  const query = await searchParams;
  const requestedMode = Array.isArray(query.mode) ? query.mode[0] : query.mode;
  const loginMode = requestedMode === "forgot" || requestedMode === "register" ? requestedMode : "login";
  if (!segments.length) notFound();
  return <RivertonRoute segments={segments} loginMode={loginMode} />;
}
