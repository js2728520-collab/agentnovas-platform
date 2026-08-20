"use client";

import { useEffect, useMemo, useState } from "react";

import type { CursorPage } from "./commercial-workspace-types";
import { formatDateTime, formatDecimal } from "@/packages/contracts/src/riverton-ui";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type CreditAccountView = {
  customerId: string;
  accountStatus: "ACTIVE" | "NOT_OPENED";
  available: string;
  reserved: string;
  version: string;
  updatedAt: string;
};

export function CreditsWorkspace() {
  const [ready, setReady] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [draftCustomerId, setDraftCustomerId] = useState("");
  const [cursor, setCursor] = useState("");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const initialCustomer = params.get("customerId") ?? "";
      setCustomerId(initialCustomer);
      setDraftCustomerId(initialCustomer);
      setCursor(params.get("cursor") ?? "");
      setReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const url = useMemo(() => {
    if (!ready) return null;
    const params = new URLSearchParams({ limit: "30" });
    if (customerId) params.set("customerId", customerId);
    if (cursor) params.set("cursor", cursor);
    return `/api/operations/credits?${params}`;
  }, [cursor, customerId, ready]);
  const resource = useApiData<CursorPage<CreditAccountView>>(
    url,
    "Credits 账户读取失败",
  );
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams();
    if (customerId) params.set("customerId", customerId);
    if (cursor) params.set("cursor", cursor);
    window.history.replaceState(
      null,
      "",
      `/credits${params.size ? `?${params}` : ""}`,
    );
  }, [cursor, customerId, ready]);

  return (
    <>
      <PageHeading
        eyebrow="AI CREDITS"
        title="客户 Credits"
        description="只读展示当前 RBAC 数据范围内的可用与冻结余额；Beta 不开放人工调整入口。"
        actions={
          <button
            className="rc-button"
            type="button"
            onClick={() => void resource.refresh()}
          >
            刷新
          </button>
        }
      />
      <section className="rc-panel">
        <header>
          <div>
            <small>SCOPED READ ONLY</small>
            <h2>Credits 账户</h2>
          </div>
        </header>
        <form
          className="rc-filter-row"
          onSubmit={(event) => {
            event.preventDefault();
            setCustomerId(draftCustomerId.trim());
            setCursor("");
          }}
        >
          <label>
            <span>客户 ID（精确）</span>
            <input
              maxLength={100}
              value={draftCustomerId}
              onChange={(event) => setDraftCustomerId(event.target.value)}
            />
          </label>
          <button className="rc-primary" type="submit">
            查询
          </button>
        </form>
        {!ready || (resource.loading && !resource.data) ? (
          <LoadingState label="正在读取 Credits 账户…" />
        ) : resource.error && !resource.data ? (
          <ErrorState message={resource.error} retry={resource.refresh} />
        ) : !resource.data?.data.length ? (
          <EmptyState
            title="没有 Credits 账户"
            description="当前查询或数据范围内没有客户账户。"
          />
        ) : (
          <div className="rc-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>客户</th>
                  <th>可用</th>
                  <th>冻结</th>
                  <th>账户状态</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.data.map((account) => (
                  <tr key={account.customerId}>
                    <td>
                      <code>{account.customerId}</code>
                      <small>版本 {account.version}</small>
                    </td>
                    <td>{formatDecimal(account.available, 0)}</td>
                    <td>{formatDecimal(account.reserved, 0)}</td>
                    <td>
                      <StatusBadge value={account.accountStatus} />
                    </td>
                    <td>{formatDateTime(account.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {resource.data?.page.hasMore && (
          <div className="rc-action-row">
            <button
              className="rc-button"
              type="button"
              onClick={() =>
                setCursor(resource.data?.page.nextCursor ?? "")
              }
            >
              下一页
            </button>
          </div>
        )}
      </section>
    </>
  );
}
