"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { AppAudience } from "@/lib/riverton-apps";
import { apiErrorMessage, safeNextPath } from "@/packages/contracts/src/riverton-ui";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type LoginMode = "login" | "register" | "forgot" | "verify";
type MfaFlow =
  | { stage: "enroll"; setupKey: string }
  | { stage: "verify" }
  | { stage: "recovery"; recoveryCodes: string[] }
  | null;

function setupKeyFromUri(value: unknown) {
  try {
    const secret = new URL(String(value)).searchParams.get("secret")?.trim();
    return secret && /^[A-Z2-7]{16,128}$/i.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

/**
 * 从当前 URL 取邀请码。
 *
 * 收到链接的人不该需要知道「先点注册、再把码抄进去」——那一步是纯粹的摩擦，
 * 而且 8 位码抄错一位就得从头再来。
 */
function readInvitationCodeFromUrl(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("invite")?.trim() ?? "";
}

/**
 * 权限注册链接：/login#staff-invite=<code>&app=operations。fragment 不会发送到代理或
 * Next.js 服务端，因此高熵 token 不会进入访问日志。
 *
 * 与客户链接分开读，因为两者走完全不同的注册接口和 token 表：客户走
 * /api/auth/register；内部五级角色走 /api/organization/staff-register 并立即获得
 * 链接冻结的角色、权限和组织范围。
 */
function readStaffInviteFromUrl(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("staff-invite")?.trim() ?? "";
}

function subscribeToLocationChange(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

const emptyLocationSnapshot = () => "";
const subscribeToHydration = () => () => undefined;
const hydratedSnapshot = () => true;
const serverHydrationSnapshot = () => false;

export function AppLogin({ audience, title, description, allowRegistration, initialMode = "login" }: {
  audience: AppAudience;
  title: string;
  description: string;
  allowRegistration: boolean;
  initialMode?: LoginMode;
}) {
  const { t } = useAppLocale();
  const safeInitialMode = audience === "client" && initialMode === "forgot"
    ? "forgot"
    : allowRegistration && initialMode === "register" ? "register" : "login";
  // 邀请链接来自 query 或 fragment。使用具备服务端空快照的外部 store，既避免
  // effect 级联渲染，也确保服务端首屏与浏览器 hydration 快照一致。
  const invitedCode = useSyncExternalStore(subscribeToLocationChange, readInvitationCodeFromUrl, emptyLocationSnapshot);
  const staffInviteCode = useSyncExternalStore(subscribeToLocationChange, readStaffInviteFromUrl, emptyLocationSnapshot);
  const isHydrated = useSyncExternalStore(subscribeToHydration, hydratedSnapshot, serverHydrationSnapshot);
  const [staffState, setStaffState] = useState<{ status: "idle" | "busy" | "done"; message: string }>(
    { status: "idle", message: "" },
  );
  const [mode, setMode] = useState<LoginMode>(invitedCode ? "register" : safeInitialMode);
  const [verificationEmail, setVerificationEmail] = useState("");
  const [mfaFlow, setMfaFlow] = useState<MfaFlow>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const mfaCodeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mfaFlow?.stage === "enroll" || mfaFlow?.stage === "verify") {
      mfaCodeRef.current?.focus();
    }
  }, [mfaFlow?.stage]);

  function enterApplication() {
    const params = new URLSearchParams(window.location.search);
    const defaultPath = audience === "client" ? "/dashboard" : "/";
    window.location.assign(safeNextPath(params.get("next"), defaultPath));
  }

  async function postJson(endpoint: string, body: Record<string, unknown>) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(apiErrorMessage(payload, t("操作失败，请稍后重试")));
    return payload;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isHydrated || busy || mfaFlow?.stage === "recovery") return;
    setBusy(true);
    setMessage("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (mfaFlow?.stage === "enroll") {
        const result = await postJson("/api/auth/mfa/enroll/confirm", { code: values.code });
        const recoveryCodes = Array.isArray(result.recoveryCodes)
          ? result.recoveryCodes.filter((code): code is string => typeof code === "string" && code.length > 0)
          : [];
        if (recoveryCodes.length === 0) throw new Error(t("恢复码生成失败，请联系运维管理员"));
        setMfaFlow({ stage: "recovery", recoveryCodes });
        return;
      }
      if (mfaFlow?.stage === "verify") {
        await postJson("/api/auth/mfa/verify", { code: values.code });
        enterApplication();
        return;
      }

      const endpoint = mode === "register"
        ? "/api/auth/register"
        : mode === "forgot" ? "/api/auth/forgot-password"
          : mode === "verify" ? "/api/auth/resend-verification" : "/api/auth/login";
      const payload = await postJson(endpoint, values);
      if (mode === "login") {
        if (payload.mfaRequired === true) {
          if (payload.mfaEnrollmentRequired === true) {
            const enrollment = await postJson("/api/auth/mfa/enroll/start", {});
            const setupKey = setupKeyFromUri(enrollment.otpauthUri);
            if (!setupKey) throw new Error(t("双重验证设置密钥无效，请重新登录"));
            setMfaFlow({ stage: "enroll", setupKey });
          } else {
            setMfaFlow({ stage: "verify" });
          }
          return;
        }
        enterApplication();
        return;
      }
      setMessage(apiErrorMessage(payload, mode === "forgot" ? t("如果邮箱存在，重置邮件已进入发送队列") : mode === "verify" ? t("如果账户待验证，验证邮件已进入发送队列") : t("注册成功，请完成邮箱验证")));
      if (mode === "register") {
        setVerificationEmail(String(values.email ?? ""));
        setMode("verify");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("操作失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  function switchMode(nextMode: LoginMode) {
    setMode(nextMode);
    setMfaFlow(null);
    setMessage("");
  }

  const heading = t(mfaFlow?.stage === "enroll"
    ? "绑定双重验证"
    : mfaFlow?.stage === "verify" ? "双重验证"
      : mfaFlow?.stage === "recovery" ? "保存恢复码"
        : mode === "register" ? "创建客户账户" : mode === "forgot" ? "重置登录密码" : mode === "verify" ? "验证账户邮箱" : "安全登录");
  const helper = t(mfaFlow?.stage === "enroll"
    ? "将设置密钥加入身份验证器，再输入当前六位动态验证码。"
    : mfaFlow?.stage === "verify" ? "输入身份验证器动态验证码，或使用一枚尚未使用的恢复码。"
      : mfaFlow?.stage === "recovery" ? "恢复码仅显示一次。请保存到独立的安全位置后再进入应用。"
        : mode === "login" ? "请输入当前应用获授权的账户。"
          : mode === "forgot" ? "重置链接仅发送到已登记邮箱。" : mode === "verify" ? "验证链接有效期为 24 小时；重发会使旧链接失效。" : "客户注册需要有效邀请码。");

  return <main className={`rc-auth rc-auth-${audience}`}>
    <section className="rc-auth-brand"><Link href="/" prefetch={false}>{audience === "client" ? <Image src="/riverton-capital-logo.png" width={2193} height={324} sizes="220px" alt="Riverton Capital" priority /> : "R"}</Link><div><small>{audience.toUpperCase()} ACCESS</small><h1>{t(title)}</h1><p>{t(description)}</p></div><ul><li>{t("独立应用会话")}</li><li>{t("服务端权限校验")}</li><li>{t("完整操作审计")}</li></ul></section>
    {/* 权限注册链接接管整个表单：它走独立 token 与注册事务。
        与登录/客户注册并排显示只会让人不知道该填哪个。 */}
    {staffInviteCode && staffState.status !== "done" ? (
      <form
        className="rc-auth-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!isHydrated || staffState.status === "busy") return;
          const data = new FormData(event.currentTarget);
          setStaffState({ status: "busy", message: "" });
          try {
            const response = await fetch("/api/organization/staff-register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                code: staffInviteCode,
                email: String(data.get("email") ?? ""),
                password: String(data.get("password") ?? ""),
                organizationName: String(data.get("organizationName") ?? ""),
              }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(apiErrorMessage(payload, t("注册失败")));
            setStaffState({ status: "done", message: String(payload.message ?? t("注册成功")) });
          } catch (error) {
            setStaffState({
              status: "idle",
              message: error instanceof Error ? error.message : t("注册失败"),
            });
          }
        }}
      >
        <h2>{t("加入团队")}</h2>
        <p>{t("你收到了一条权限注册链接。注册者不能修改角色或数据范围；提交成功后账号立即生效。双重验证能力已保留，是否强制由当前部署阶段的安全策略决定。")}</p>
        <label>{t("邮箱")}<input name="email" type="email" autoComplete="email" required /></label>
        <label>{t("密码（至少 12 位）")}<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
        <label>{t("分公司名称（仅分公司总经理链接必填）")}<input name="organizationName" maxLength={120} /></label>
        {staffState.message ? <p role="alert">{staffState.message}</p> : null}
        <button type="submit" disabled={!isHydrated || staffState.status === "busy"}>
          {staffState.status === "busy" ? t("提交中…") : t("提交注册")}
        </button>
      </form>
    ) : null}
    {staffState.status === "done" ? (
      <div role="status"><p>{staffState.message}</p><Link href="/login">{t("返回登录")}</Link></div>
    ) : null}
    {!staffInviteCode ? (
    <form method="post" onSubmit={submit} aria-labelledby="rc-login-heading">
      <header><small>RIVERTON CAPITAL</small><h2 id="rc-login-heading">{heading}</h2><p>{helper}</p></header>
      {!mfaFlow && mode === "register" && <><label>{t("手机号（含国际区号）")}<input name="phone" type="tel" autoComplete="tel" required /></label><label>{t("邮箱")}<input name="email" type="email" autoComplete="email" required /></label><label>{t("邀请码")}<input
          name="invitationCode"
          required
          autoCapitalize="characters"
          defaultValue={invitedCode}
          // 链接带来的码仍然可改：链接可能过期或被换掉，锁死会让人卡在这里无路可走。
          key={invitedCode}
        /></label></>}
      {!mfaFlow && (mode === "forgot" || mode === "verify" ? <label>{t("账户邮箱")}<input name="email" type="email" autoComplete="email" defaultValue={mode === "verify" ? verificationEmail : ""} required /></label> : mode === "login" && <label>{t("邮箱、手机号或用户名")}<input name="identifier" autoComplete="username" required /></label>)}
      {!mfaFlow && mode !== "forgot" && <label>{t("密码")}<input name="password" type="password" minLength={10} autoComplete={mode === "login" ? "current-password" : "new-password"} required /></label>}
      {mfaFlow?.stage === "enroll" && <label>{t("身份验证器设置密钥")}<input className="rc-mfa-setup-key" value={mfaFlow.setupKey} readOnly aria-describedby="rc-mfa-setup-help" /></label>}
      {mfaFlow?.stage === "enroll" && <small id="rc-mfa-setup-help">{t("设置密钥属于敏感信息；完成绑定后本页不会再次显示。")}</small>}
      {(mfaFlow?.stage === "enroll" || mfaFlow?.stage === "verify") && <label>{t(mfaFlow.stage === "enroll" ? "六位动态验证码" : "动态验证码或恢复码")}<input ref={mfaCodeRef} name="code" autoComplete="one-time-code" inputMode={mfaFlow.stage === "enroll" ? "numeric" : "text"} required /></label>}
      {mfaFlow?.stage === "recovery" && <div className="rc-recovery-codes" role="status" aria-live="polite"><ul>{mfaFlow.recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ul><button className="rc-primary" type="button" onClick={enterApplication}>{t("我已安全保存，进入应用")}</button></div>}
      {message && <div className="rc-auth-message" role="status" aria-live="polite">{message}</div>}
      {mfaFlow?.stage !== "recovery" && <button className="rc-primary" disabled={!isHydrated || busy}>{t(busy ? "处理中…" : mfaFlow?.stage === "enroll" ? "绑定并生成恢复码" : mfaFlow?.stage === "verify" ? "验证并进入" : mode === "login" ? "登录" : mode === "forgot" ? "发送重置邮件" : mode === "verify" ? "重发验证邮件" : "创建账户")}</button>}
      {!mfaFlow && <footer>
        {mode !== "login" && <button type="button" onClick={() => switchMode("login")}>{t("返回登录")}</button>}
        {mode === "login" && audience === "client" && <button type="button" onClick={() => switchMode("forgot")}>{t("忘记密码")}</button>}
        {mode === "login" && audience === "client" && <button type="button" onClick={() => switchMode("verify")}>{t("重发验证邮件")}</button>}
        {mode === "login" && allowRegistration && <button type="button" onClick={() => switchMode("register")}>{t("使用邀请码注册")}</button>}
      </footer>}
    </form>
    ) : null}
  </main>;
}
