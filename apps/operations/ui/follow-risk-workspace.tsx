"use client";

import { useRef, useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type Follow = {
  subscriptionId: string;
  status: "configuring" | "user_confirmed" | "active" | "paused" | "risk_blocked";
  pausedBy: "customer" | "operations_risk" | "automated_risk" | "global_circuit_breaker" | null;
  pausedAt: string | null;
  pausedReason: string | null;
  runMode: string | null;
  capitalPct: number;
  stopLossPct: number;
  strategyName: string;
  listingStatus: string;
  delistReason: string | null;
  principalUsdt: string | null;
  realizedNetPnlUsdt: string | null;
  riskEventCount: number;
};

/** 四方权威的中文名。谁停的决定谁能恢复，因此这一列不能省。 */
const authorityLabels: Record<string, string> = {
  customer: "客户本人",
  operations_risk: "运营风控",
  automated_risk: "系统自动风控",
  global_circuit_breaker: "全局熔断",
};

export function FollowRiskWorkspace({ canManage }: { canManage: boolean }) {
  const resource = useApiData<{ follows: Follow[] }>("/api/operations/follow-risk", "跟单风控读取失败");
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const keys = useRef(new Map<string, string>());

  if (resource.loading && !resource.data) return <LoadingState label="正在读取跟单风控状态…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const follows = resource.data?.follows ?? [];

  async function act(subscriptionId: string, action: "pause" | "resume" | "stop") {
    if (busyId) return;
    setBusyId(subscriptionId); setMessage("");
    const key = keys.current.get(`${subscriptionId}:${action}`) ?? crypto.randomUUID();
    keys.current.set(`${subscriptionId}:${action}`, key);
    try {
      const response = await fetch(
        `/api/operations/follow-risk/${encodeURIComponent(subscriptionId)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ action, reason }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(body, "风控操作失败"));
      setMessageKind("success");
      setMessage(`已${action === "pause" ? "阻断" : action === "resume" ? "解除阻断" : "终止"}该跟单`);
      setReason("");
      keys.current.delete(`${subscriptionId}:${action}`);
      await resource.refresh();
    } catch (error) {
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : "风控操作失败");
    } finally { setBusyId(""); }
  }

  return <section className="rc-panel">
    <PageHeading eyebrow="FOLLOW RISK" title="跟单风控" description="阻断或恢复单个客户对社区策略的跟随。阻断单人即时生效；解除阻断需要另一位风控人员。" />
    {message && <p className={messageKind === "error" ? "rc-inline-error" : "rc-muted"} role="status">{message}</p>}

    {canManage && <div className="rc-form rc-form-grid rc-config-action-block">
      <InlineAuditReasonField id="follow-risk-reason" value={reason} onChange={setReason}
        label="风控操作原因" hint="一个没有理由的阻断，事后没人知道能不能摘。" />
    </div>}

    {follows.length === 0
      ? <EmptyState title="当前没有进行中的跟单" description="客户开启模拟跟单后会出现在这里。" />
      : <div className="rc-table-wrap"><table>
        <thead><tr>
          <th>策略</th><th>状态</th><th>谁停的</th><th>原因</th>
          <th>止损线</th><th>已实现盈亏</th><th>风控事件</th>
          {canManage && <th>操作</th>}
        </tr></thead>
        <tbody>
          {follows.map((follow) => <tr key={follow.subscriptionId}>
            <td>
              {follow.strategyName}
              {/* 策略已下架而跟随还在，是运营最需要一眼看到的组合。 */}
              {follow.listingStatus === "delisted" && <small className="rc-warning"> · 策略已下架（{follow.delistReason ?? "原因未记录"}）</small>}
            </td>
            <td><StatusBadge value={follow.status} /></td>
            {/* 谁停的决定谁能恢复。空着说明它没被停，不是「不知道谁停的」。 */}
            <td>{follow.pausedBy ? authorityLabels[follow.pausedBy] ?? follow.pausedBy : "—"}</td>
            <td><small>{follow.pausedReason ?? "—"}</small>{follow.pausedAt && <small> · {formatDateTime(follow.pausedAt)}</small>}</td>
            <td>{follow.stopLossPct}%</td>
            <td>{follow.realizedNetPnlUsdt ?? "—"}</td>
            <td>{follow.riskEventCount}</td>
            {canManage && <td>
              <div className="rc-action-row">
                {follow.status === "active" && <button type="button" className="rc-danger-button"
                  disabled={busyId !== "" || !hasValidAuditReason(reason)}
                  onClick={() => void act(follow.subscriptionId, "pause")}>阻断</button>}
                {(follow.status === "paused" || follow.status === "risk_blocked") && <button type="button"
                  disabled={busyId !== "" || !hasValidAuditReason(reason)}
                  onClick={() => void act(follow.subscriptionId, "resume")}>解除阻断</button>}
                <button type="button" className="rc-danger-button"
                  disabled={busyId !== "" || !hasValidAuditReason(reason)}
                  onClick={() => void act(follow.subscriptionId, "stop")}>终止</button>
              </div>
            </td>}
          </tr>)}
        </tbody>
      </table></div>}

    <p className="rc-muted">
      解除阻断不能由当初阻断的人自己完成——出事时没有时间等第二个人签字，但把风险重新打开
      不该由同一个人独自决定。系统自动风控与全局熔断造成的阻断，运营风控无法解除。
    </p>
  </section>;
}
