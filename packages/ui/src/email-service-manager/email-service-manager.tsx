"use client";

import { useState, type KeyboardEvent } from "react";

import { EmailServiceConfiguration } from "./email-service-configuration";
import { EmailServiceOverview } from "./email-service-overview";
import { EmailServiceTests } from "./email-service-tests";
import type { EmailServiceManagerProps } from "./types";

type Tab = "overview" | "configuration" | "tests";

export function EmailServiceManager(props: EmailServiceManagerProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const t = props.translate ?? (value => value);
  const tabs: Array<{ value: Tab; label: string }> = [
    { value: "overview", label: t("概况") },
    { value: "configuration", label: t("配置") },
    { value: "tests", label: t("测试与记录") },
  ];
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const keyOffset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : keyOffset
          ? (index + keyOffset + tabs.length) % tabs.length
          : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    setTab(tabs[nextIndex].value);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[nextIndex]?.focus();
  }
  return <>
    <div className="rc-hub-tabs" role="tablist" aria-label={t("邮件服务管理")}>
      {tabs.map((item, index) => <button key={item.value} id={`email-service-tab-${item.value}`} type="button" role="tab" aria-selected={tab === item.value} aria-controls={`email-service-panel-${item.value}`} tabIndex={tab === item.value ? 0 : -1} onKeyDown={event => moveTab(event, index)} onClick={() => setTab(item.value)}>{item.label}</button>)}
    </div>
    <div id={`email-service-panel-${tab}`} role="tabpanel" aria-labelledby={`email-service-tab-${tab}`} tabIndex={0}>
      {tab === "overview" ? <EmailServiceOverview status={props.status} formatDateTime={props.formatDateTime} translate={props.translate} /> : null}
      {tab === "configuration" ? <EmailServiceConfiguration {...props} /> : null}
      {tab === "tests" ? <EmailServiceTests {...props} /> : null}
    </div>
    <div className="rc-live" aria-live="polite">{props.message}</div>
  </>;
}

export type { EmailServiceManagerProps } from "./types";
