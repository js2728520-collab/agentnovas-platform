"use client";

import type { AppAudience } from "@/lib/riverton-apps";
import type { EffectiveAccessPayload, ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import { AppPreferenceSettings } from "./app-preference-settings";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import { ConsoleHubTabs } from "./console-hub-tabs";
import { InternalAccountSecurity } from "./internal-account-security";
import { PageHeading } from "./page-state";

export type InternalSettingsTab = "profile" | "appearance" | "security";

const tabs = [
  { value: "profile", label: "个人资料", href: "/settings?tab=profile" },
  { value: "appearance", label: "外观与语言", href: "/settings?tab=appearance" },
  { value: "security", label: "账户安全", href: "/settings?tab=security" },
] satisfies Array<{ value: InternalSettingsTab; label: string; href: string }>;

export function resolveInternalSettingsTab(requested: string | null | undefined, legacyRoot?: string): InternalSettingsTab {
  if (legacyRoot === "account") return "security";
  return requested === "appearance" || requested === "security" || requested === "profile" ? requested : "profile";
}

export function InternalSettingsWorkspace({ audience, viewer, access, tab }: {
  audience: Extract<AppAudience, "operations" | "maintenance">;
  viewer: ViewerPayload;
  access: EffectiveAccessPayload;
  tab: InternalSettingsTab;
}) {
  const { locale } = useAppLocale();
  const english = locale === "en-US";
  return <>
    <ConsoleHubTabs label="个人设置" active={tab} tabs={tabs} permissions={access.permissions} />
    {tab === "appearance" ? <AppPreferenceSettings audience={audience} />
      : tab === "security" ? <InternalAccountSecurity />
        : <>
          <PageHeading eyebrow="PROFILE" title={english ? "Profile" : "个人资料"} description={english ? "Review your account identity for this application. Roles and permissions are managed through governance or access control, not personal settings." : "核对当前应用中的账户身份。角色和权限由运营治理或访问控制管理，不在个人设置中修改。"} />
          <section className="rc-panel"><dl className="rc-description-list">
            <div><dt>{english ? "Display name" : "显示名称"}</dt><dd>{viewer.nickname || viewer.username || (english ? "Not set" : "未设置")}</dd></div>
            <div><dt>{english ? "Sign-in email" : "登录邮箱"}</dt><dd>{viewer.email}</dd></div>
            <div><dt>{english ? "Account role" : "账户角色"}</dt><dd>{viewer.role}</dd></div>
            <div><dt>{english ? "Time zone" : "时区"}</dt><dd>{viewer.timezone || "Asia/Shanghai"}</dd></div>
          </dl></section>
        </>}
  </>;
}
