import { headers } from "next/headers";
import { notFound } from "next/navigation";

import CurrentApp from "@/app/audience/current-root";
import { isRivertonAppRoute } from "@/app/riverton-route-contract";
import { resolveAppAudienceStrict } from "@/lib/riverton-apps";

export async function RivertonRoute({ segments, loginMode }: { segments: string[]; loginMode?: "login" | "register" | "forgot" }) {
  const audience = resolveAppAudienceStrict({ host: (await headers()).get("host") ?? undefined });
  if (!audience) notFound();
  if (!isRivertonAppRoute(audience, segments)) notFound();
  return <CurrentApp audience={audience} segments={segments} loginMode={loginMode} />;
}
