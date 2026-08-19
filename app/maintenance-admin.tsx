"use client";

import { useCallback, useEffect, useState } from "react";
import type { AccountViewer } from "./account-settings";
import {
  MaintenanceAiPanel,
  MaintenanceBillingPanel,
  MaintenanceFeaturePanel,
  MaintenanceIntegrationPanel,
  MaintenanceOperationsPanel,
  MaintenanceRolesPanel,
  MaintenanceSecurityPanel,
  MaintenanceSystemPanel,
} from "./maintenance-control-panels";

export type AdminBackend = "operations" | "maintenance";

type MaintenancePanel = "strategyReviews" | "system" | "features" | "ai" | "billing" | "roles" | "integrations" | "operations" | "security";

const menu: Array<[MaintenancePanel, string, string]> = [
  ["strategyReviews", "策略审核", "用户上传策略待审核提醒"],
  ["system", "系统配置", "品牌、站点、多语言"],
  ["features", "功能开关", "模块启停与版本"],
  ["ai", "AI 助手运营", "模型、技能、用量"],
  ["billing", "计费与支付", "套餐、价格、支付"],
  ["roles", "权限与角色", "角色创建与权限分配"],
  ["integrations", "集成管理", "行情、数据、通知"],
  ["operations", "系统运维", "状态、日志、任务"],
  ["security", "安全设置", "登录、风控、黑名单"],
];

function StatusBadge({ children, tone = "ok" }: { children: React.ReactNode; tone?: "ok" | "muted" | "warn" }) {
  return <span className={`maintenance-status is-${tone}`}><i />{children}</span>;
}

type StrategyApprovalRow = {
  id: string;
  subjectId: string;
  requestedAt: string;
  payload?: Record<string, unknown>;
  approvals?: number;
  required?: number;
};

function StrategyReviewPanel() {
  const [rows, setRows] = useState<StrategyApprovalRow[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const response = await fetch("/api/approvals", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data.error || `HTTP ${response.status}`));
      const strategyRows = Array.isArray(data.requests)
        ? data.requests.filter((row: { type?: string }) => row.type === "strategy_listing")
        : [];
      setRows(strategyRows as StrategyApprovalRow[]);
      setMessage("");
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "加载审核提醒失败");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const decide = async (row: StrategyApprovalRow, decision: "approve" | "reject") => {
    const payload = row.payload || {};
    const strategyName = String(payload.strategyName || payload.name || row.subjectId);
    const note = window.prompt(decision === "approve" ? `确认通过“${strategyName}”吗？可填写审核备注。` : `请输入驳回“${strategyName}”的原因：`, "");
    if (note === null || (decision === "reject" && !note.trim())) return;
    setActionId(row.id);
    try {
      const response = await fetch(`/api/approvals/${row.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note.trim() || undefined }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data.error || `HTTP ${response.status}`));
      await load();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "提交审核结果失败");
    } finally {
      setActionId(null);
    }
  };

  return <section className="maintenance-panel maintenance-review-panel">
    <header>
      <div><span className="eyebrow">STRATEGY REVIEW</span><h2>策略上架审核</h2><p>策略广场用户上传并提交的策略，会先进入这里审核；审核完成后才会对外展示。</p></div>
      <div className="maintenance-review-count"><b>{rows.length}</b><span>待审核</span></div>
    </header>
    <div className="maintenance-review-banner"><span className="maintenance-review-banner-icon">!</span><div><b>首要审核提醒</b><span>请优先处理策略广场的用户提交。当前由运维角色单人审核，审核通过后立即上架。</span></div><StatusBadge tone={rows.length ? "warn" : "ok"}>{rows.length ? "需要处理" : "暂无待审核"}</StatusBadge></div>
    {status === "loading" && <div className="maintenance-review-empty">正在加载策略审核提醒…</div>}
    {status === "error" && <div className="maintenance-review-empty is-error">{message || "加载失败"}<button className="soft" onClick={() => void load()}>重新加载</button></div>}
    {status === "ready" && rows.length === 0 && <div className="maintenance-review-empty">暂无用户上传策略等待审核。</div>}
    {status === "ready" && rows.length > 0 && <div className="maintenance-review-list">{rows.map((row) => {
      const payload = row.payload || {};
      const strategyName = String(payload.strategyName || payload.name || row.subjectId);
      const summary = String(payload.summary || "用户提交的策略广场上架申请");
      const approvals = Number(row.approvals || 0);
      const required = Number(row.required || 1);
      return <article className="maintenance-review-item" key={row.id}>
        <div className="maintenance-review-item-head"><div><b>{strategyName}</b><span>{summary}</span></div><StatusBadge tone={approvals ? "ok" : "warn"}>{approvals}/{required} 已通过</StatusBadge></div>
        <div className="maintenance-review-meta"><span>策略 ID：{row.subjectId}</span><span>版本：{String(payload.version || "-")}</span><span>提交时间：{new Date(row.requestedAt).toLocaleString("zh-CN")}</span></div>
        <div className="maintenance-review-actions"><button className="soft danger" onClick={() => void decide(row, "reject")} disabled={actionId === row.id}>驳回</button><button className="primary" onClick={() => void decide(row, "approve")} disabled={actionId === row.id}>{actionId === row.id ? "提交中…" : "审核通过"}</button></div>
      </article>;
    })}</div>}
  </section>;
}

function MaintenanceInviteAction() {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const create = async () => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "maintenance_admin_single_use" }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data.error || "生成运维邀请码失败"));
      setCode(String(data.invitation?.code || ""));
      setMessage("一次性邀请码已生成，请立即复制保存。注册后该邀请码自动失效。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成运维邀请码失败");
    } finally {
      setLoading(false);
    }
  };
  return <section className="maintenance-invite-action"><div><span className="eyebrow">MAINTENANCE INVITE</span><h3>邀请注册运维账号</h3><p>仅超级管理员可生成。运维账号登录后只进入运维后台，不显示运营后台。</p></div><button className="primary" onClick={() => void create()} disabled={loading}>{loading ? "生成中…" : "生成运维邀请码"}</button>{code && <code>{code}</code>}{message && <small>{message}</small>}</section>;
}

export function AdminGateway({ viewer, onSelect }: { viewer: AccountViewer | null; onSelect: (backend: AdminBackend) => void }) {
  const canOpenMaintenance = viewer?.role === "hq_admin" || viewer?.role === "maintenance_admin";
  return <div className="admin-gateway">
    <header className="admin-gateway-head">
      <div>
        <span className="eyebrow">ADMIN CONSOLE</span>
        <h1>选择后台</h1>
        <p>共用现有数据库，按职责进入独立功能区。运营人员处理业务，技术人员维护平台。</p>
      </div>
      <StatusBadge>数据库连接正常</StatusBadge>
    </header>
    <div className="admin-gateway-grid">
      <button type="button" className="admin-gateway-card operations" onClick={() => onSelect("operations")}>
        <span className="admin-gateway-icon">⌁</span>
        <div className="admin-gateway-card-copy">
          <span className="eyebrow">BUSINESS OPERATIONS</span>
          <h2>运营后台</h2>
          <p>给公司内部人员使用，负责客户、组织、邀请码、任务、审批、分红与结算等日常运营工作。</p>
          <div className="admin-gateway-pills"><span>组织成员</span><span>客户管理</span><span>数据中心</span><span>审批结算</span></div>
        </div>
        <span className="admin-gateway-enter">进入运营后台 <b>→</b></span>
      </button>
      <button type="button" className={`admin-gateway-card maintenance${canOpenMaintenance ? "" : " is-locked"}`} onClick={() => canOpenMaintenance && onSelect("maintenance")} disabled={!canOpenMaintenance}>
        <span className="admin-gateway-icon">⌘</span>
        <div className="admin-gateway-card-copy">
          <span className="eyebrow">PLATFORM MAINTENANCE</span>
          <h2>运维后台</h2>
          <p>给总公司技术人员使用，负责系统配置、AI 接口、集成服务、系统运维与安全策略。</p>
          <div className="admin-gateway-pills"><span>策略审核</span><span>系统配置</span><span>AI 助手</span><span>集成管理</span></div>
        </div>
        <span className="admin-gateway-enter">{canOpenMaintenance ? <>进入运维后台 <b>→</b></> : <>仅总公司技术权限 <b>⌑</b></>}</span>
      </button>
    </div>
    <div className="admin-gateway-note"><i /> 当前账号：{viewer?.nickname || viewer?.username || viewer?.email || "未登录"} · 后台权限由服务端再次校验，卡片入口不会改变数据库权限。</div>
    {viewer?.role === "hq_admin" && <MaintenanceInviteAction />}
  </div>;
}

export default function MaintenanceAdmin({ viewer, onBack }: { viewer: AccountViewer | null; onBack: () => void }) {
  const [panel, setPanel] = useState<MaintenancePanel>("strategyReviews");
  const current = menu.find(item => item[0] === panel) || menu[0];

  useEffect(() => {
    const resetScroll = () => window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    resetScroll();
    const frame = window.requestAnimationFrame(resetScroll);
    const timer = window.setTimeout(resetScroll, 120);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [panel]);

  return <div className="maintenance-admin">
    <header className="maintenance-head"><div><span className="eyebrow">PLATFORM MAINTENANCE</span><h1>运维后台</h1><p>给总公司技术人员使用 · 与运营后台共用数据库，功能和权限独立</p></div><div className="maintenance-head-actions"><StatusBadge>{viewer?.role === "maintenance_admin" ? "运维权限" : "总公司技术权限"}</StatusBadge><button className="soft" onClick={onBack}>{viewer?.role === "maintenance_admin" ? "退出运维后台" : "返回后台选择"}</button></div></header>
    <div className="maintenance-shell"><aside className="maintenance-menu"><div className="maintenance-menu-title"><b>运维控制台</b><small>{viewer?.nickname || viewer?.username || "HQ Admin"}</small></div>{menu.map(([key, label, description]) => <button key={key} className={panel === key ? "active" : ""} onClick={() => setPanel(key)}><span className="maintenance-menu-icon">{key === "strategyReviews" ? "!" : key === "system" ? "⌂" : key === "features" ? "◈" : key === "ai" ? "✦" : key === "billing" ? "￥" : key === "roles" ? "♢" : key === "integrations" ? "⇄" : key === "operations" ? "◌" : "◇"}</span><span><b>{label}</b><small>{description}</small></span></button>)}</aside><main className="maintenance-main"><div className="maintenance-breadcrumb"><span>运维后台</span><b>/</b><strong>{current[1]}</strong></div>{panel === "strategyReviews" && <StrategyReviewPanel />}{panel === "system" && <MaintenanceSystemPanel />}{panel === "features" && <MaintenanceFeaturePanel />}{panel === "ai" && <MaintenanceAiPanel />}{panel === "billing" && <MaintenanceBillingPanel />}{panel === "roles" && <MaintenanceRolesPanel />}{panel === "integrations" && <MaintenanceIntegrationPanel />}{panel === "operations" && <MaintenanceOperationsPanel />}{panel === "security" && <MaintenanceSecurityPanel />}</main></div>
  </div>;
}
