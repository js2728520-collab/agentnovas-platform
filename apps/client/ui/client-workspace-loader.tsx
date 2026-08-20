"use client";

import dynamic from "next/dynamic";

const ClientApp = dynamic(() => import("./client-app"), {
  loading: () => <main className="content" aria-busy="true"><div className="notice" role="status" aria-live="polite">正在加载策略与 Agent 工作区…</div></main>,
});

export default function ClientWorkspaceLoader() {
  return <ClientApp />;
}
