"use client";

import { useRef, useState } from "react";

import type { ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

import { ClientMfaPanel } from "./client-mfa-panel";

type AccountSession = {
  id: string;
  audience: "client" | "operations" | "maintenance";
  current: boolean;
  device: string;
  maskedIpAddress: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
};

export function AccountSecurityWorkspace({ viewer }: { viewer: ViewerPayload }) {
  const sessions = useApiData<{ sessions: AccountSession[] }>("/api/account/sessions", "登录设备读取失败");
  const [profile, setProfile] = useState({
    username: viewer.username ?? "",
    nickname: viewer.nickname ?? "",
    phone: viewer.phone ?? "",
    dateOfBirth: viewer.dateOfBirth ?? "",
    gender: viewer.gender ?? "",
    timezone: viewer.timezone ?? "Asia/Shanghai",
  });
  const [password, setPassword] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [profileCurrentPassword, setProfileCurrentPassword] = useState("");
  const [savedIdentifiers, setSavedIdentifiers] = useState({ username: viewer.username ?? "", phone: viewer.phone ?? "" });
  const [revoking, setRevoking] = useState<AccountSession | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const loginIdentifierChanged = profile.username.trim() !== savedIdentifiers.username
    || profile.phone.trim() !== savedIdentifiers.phone;

  function announce(kind: "success" | "error", text: string) {
    setMessage({ kind, text });
    window.setTimeout(() => resultRef.current?.focus(), 0);
  }

  async function saveProfile() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/account/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...profile, currentPassword: profileCurrentPassword }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "资料保存失败"));
      const updated = payload.user as { username?: string | null; phone?: string | null } | undefined;
      const nextIdentifiers = { username: updated?.username ?? profile.username.trim(), phone: updated?.phone ?? profile.phone.trim() };
      setSavedIdentifiers(nextIdentifiers);
      setProfile((current) => ({ ...current, ...nextIdentifiers }));
      setProfileCurrentPassword("");
      const sessionsRevoked = typeof payload.sessionsRevoked === "number" ? payload.sessionsRevoked : 0;
      announce("success", sessionsRevoked > 0 ? `个人资料已保存，其他 ${sessionsRevoked} 个登录会话已撤销。` : "个人资料已保存。");
    } catch (error) {
      announce("error", error instanceof Error ? error.message : "资料保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function changePassword() {
    if (busy) return;
    if (password.newPassword !== password.confirmPassword) {
      announce("error", "两次输入的新密码不一致。");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/account/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: password.currentPassword, newPassword: password.newPassword }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "密码修改失败"));
      announce("success", "密码已修改，所有会话均已撤销。正在返回登录页…");
      window.setTimeout(() => window.location.assign("/login"), 900);
    } catch (error) {
      announce("error", error instanceof Error ? error.message : "密码修改失败");
      setBusy(false);
    }
  }

  async function revokeSession(reason: string) {
    if (!revoking || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/account/sessions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: revoking.id, reason }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "会话撤销失败"));
      setRevoking(null);
      announce("success", "该设备会话已撤销。");
      await sessions.refresh();
    } catch (error) {
      announce("error", error instanceof Error ? error.message : "会话撤销失败");
    } finally {
      setBusy(false);
    }
  }

  async function revokeAllSessions(reason: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/account/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "全部设备退出失败"));
      setRevokeAllOpen(false);
      announce("success", "全部设备已退出，正在返回登录页…");
      window.setTimeout(() => window.location.assign("/login"), 900);
    } catch (error) {
      announce("error", error instanceof Error ? error.message : "全部设备退出失败");
      setBusy(false);
    }
  }

  return <>
    <PageHeading eyebrow="ACCOUNT SECURITY" title="账号与登录安全" description="维护个人资料、更新密码并核对仍然有效的登录设备。密码修改会撤销全部会话。" actions={<StatusBadge value="Client 会话 · 最长 7 天" />} />
    {message ? <div ref={resultRef} className={message.kind === "error" ? "rc-error" : "rc-live"} role={message.kind === "error" ? "alert" : "status"} aria-live={message.kind === "error" ? "assertive" : "polite"} tabIndex={-1}>{message.text}</div> : <div className="rc-live" aria-live="polite" />}
    <section className="rc-panel">
      <header><div><small>PROFILE</small><h2>个人资料</h2></div></header>
      <div className="rc-form rc-form-grid">
        <label>用户名<input maxLength={32} value={profile.username} onChange={(event) => setProfile((current) => ({ ...current, username: event.target.value }))} /></label>
        <label>昵称<input maxLength={40} value={profile.nickname} onChange={(event) => setProfile((current) => ({ ...current, nickname: event.target.value }))} /></label>
        <label>手机号（登录标识）<input type="tel" autoComplete="tel" maxLength={32} value={profile.phone} onChange={(event) => setProfile((current) => ({ ...current, phone: event.target.value }))} /><small>将统一保存为规范格式；若没有其他用户名或可用邮箱，手机号不能清除。</small></label>
        <label>出生日期（可选）<input type="date" value={profile.dateOfBirth} onChange={(event) => setProfile((current) => ({ ...current, dateOfBirth: event.target.value }))} /></label>
        <label>性别<select value={profile.gender} onChange={(event) => setProfile((current) => ({ ...current, gender: event.target.value }))}><option value="">未设置</option><option value="female">女</option><option value="male">男</option><option value="other">其他</option></select></label>
        <label>时区<select value={profile.timezone} onChange={(event) => setProfile((current) => ({ ...current, timezone: event.target.value }))}><option value="Asia/Shanghai">中国标准时间</option><option value="Asia/Tokyo">日本标准时间</option><option value="America/New_York">美国东部时间</option><option value="Europe/London">英国时间</option><option value="UTC">UTC</option></select></label>
        {loginIdentifierChanged ? <label className="rc-wide-field">当前密码<input type="password" autoComplete="current-password" maxLength={128} value={profileCurrentPassword} onChange={(event) => setProfileCurrentPassword(event.target.value)} /><small>用户名或手机号是登录标识。变更后会撤销当前设备之外的所有会话。</small></label> : null}
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || (loginIdentifierChanged && profileCurrentPassword.length < 1)} onClick={() => void saveProfile()}>保存资料</button></div>
      </div>
    </section>
    <ClientMfaPanel />
    <section className="rc-panel">
      <header><div><small>PASSWORD</small><h2>修改密码</h2></div></header>
      <div className="rc-form rc-form-grid">
        <label>当前密码<input type="password" autoComplete="current-password" value={password.currentPassword} onChange={(event) => setPassword((current) => ({ ...current, currentPassword: event.target.value }))} /></label>
        <label>新密码<input type="password" autoComplete="new-password" minLength={10} value={password.newPassword} onChange={(event) => setPassword((current) => ({ ...current, newPassword: event.target.value }))} /></label>
        <label>确认新密码<input type="password" autoComplete="new-password" minLength={10} value={password.confirmPassword} onChange={(event) => setPassword((current) => ({ ...current, confirmPassword: event.target.value }))} /></label>
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || password.currentPassword.length < 1 || password.newPassword.length < 10 || password.confirmPassword.length < 10} onClick={() => void changePassword()}>确认修改并退出全部设备</button></div>
      </div>
    </section>
    <section className="rc-panel">
      <header><div><small>ACTIVE SESSIONS</small><h2>登录设备（最多 5 台）</h2></div><div className="rc-action-row"><button className="rc-button" type="button" onClick={() => void sessions.refresh()}>重新读取</button><button className="rc-button" type="button" disabled={busy} onClick={() => setRevokeAllOpen(true)}>退出全部设备</button></div></header>
      {sessions.loading && !sessions.data ? <LoadingState label="正在读取登录设备…" /> : sessions.error && !sessions.data ? <ErrorState message={sessions.error} retry={sessions.refresh} /> : <div className="rc-card-grid">{sessions.data?.sessions.length ? sessions.data.sessions.map((session) => <article className="rc-card" key={session.id}><header><StatusBadge value={session.current ? "当前设备" : session.audience} /><time>{formatDateTime(session.lastSeenAt ?? session.createdAt)}</time></header><h3>{session.device}</h3><p>{session.maskedIpAddress ?? "未记录网络地址"}</p><dl><div><dt>登录时间</dt><dd>{formatDateTime(session.createdAt)}</dd></div><div><dt>最长有效期</dt><dd>{formatDateTime(session.absoluteExpiresAt)}</dd></div></dl>{session.current ? <p className="rc-muted">当前设备请使用左侧“退出”。</p> : <footer><button className="rc-button" type="button" disabled={busy} onClick={() => setRevoking(session)}>撤销此设备</button></footer>}</article>) : <p>当前没有可展示的登录会话。</p>}</div>}
    </section>
    <ConfirmActionDialog open={revoking !== null} title="撤销登录设备" description="该设备会立即失去会话权限；历史审计记录会保留。" confirmLabel="确认撤销" busy={busy} onCancel={() => setRevoking(null)} onConfirm={(reason) => void revokeSession(reason)} />
    <ConfirmActionDialog open={revokeAllOpen} title="退出全部设备" description="当前设备和其他所有 Client 会话都会立即失效；历史审计记录会保留。" confirmLabel="确认全部退出" busy={busy} onCancel={() => setRevokeAllOpen(false)} onConfirm={(reason) => void revokeAllSessions(reason)} />
  </>;
}
