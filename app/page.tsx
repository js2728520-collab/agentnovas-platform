import CurrentApp from "@/app/audience/current-root";
import { resolveAppAudienceStrict } from "@/lib/riverton-apps";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

export default async function Page() {
  const audience = resolveAppAudienceStrict({ host: (await headers()).get("host") ?? undefined });
  if (!audience) notFound();
  return <CurrentApp audience={audience} segments={[]} />;
}
