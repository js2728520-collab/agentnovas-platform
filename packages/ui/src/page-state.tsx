"use client";

import Link from "next/link";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

export function LoadingState({ label = "正在读取数据…" }: { label?: string }) {
  const { t } = useAppLocale();
  return <div className="rc-state rc-loading" role="status" aria-busy="true" aria-live="polite" aria-label={t(label)}><i /><i /><i /><span>{t(label)}</span></div>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  const { t } = useAppLocale();
  return <section className="rc-state" role="status"><strong>{t(title)}</strong><p>{t(description)}</p></section>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  const { t } = useAppLocale();
  return <section className="rc-state rc-error" role="alert"><strong>{t("读取失败")}</strong><p>{t(message)}</p>{retry && <button className="rc-button" type="button" onClick={retry}>{t("重新读取")}</button>}</section>;
}

export function AccessDenied({ message = "当前账户没有访问此模块的权限。" }: { message?: string }) {
  const { t } = useAppLocale();
  return <section className="rc-state rc-denied" role="alert"><strong>{t("无权访问")}</strong><p>{t(message)}</p><Link className="rc-button" href="/">{t("返回工作台")}</Link></section>;
}

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const { t } = useAppLocale();
  const normalized = String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return <span className={`rc-status is-${normalized}`} data-status={normalized}>{t(value || "未知")}</span>;
}

export function PageHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  const { t } = useAppLocale();
  return <header className="rc-page-heading"><div><small>{eyebrow}</small><h1>{t(title)}</h1><p>{t(description)}</p></div>{actions && <div className="rc-heading-actions">{actions}</div>}</header>;
}
