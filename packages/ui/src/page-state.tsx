"use client";

import Link from "next/link";

export function LoadingState({ label = "正在读取数据…" }: { label?: string }) {
  return <div className="rc-state rc-loading" role="status" aria-busy="true" aria-live="polite" aria-label={label}><i /><i /><i /><span>{label}</span></div>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <section className="rc-state" role="status"><strong>{title}</strong><p>{description}</p></section>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <section className="rc-state rc-error" role="alert"><strong>读取失败</strong><p>{message}</p>{retry && <button className="rc-button" type="button" onClick={retry}>重新读取</button>}</section>;
}

export function AccessDenied({ message = "当前账户没有访问此模块的权限。" }: { message?: string }) {
  return <section className="rc-state rc-denied" role="alert"><strong>无权访问</strong><p>{message}</p><Link className="rc-button" href="/">返回工作台</Link></section>;
}

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const normalized = String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return <span className={`rc-status is-${normalized}`} data-status={normalized}>{value || "未知"}</span>;
}

export function PageHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <header className="rc-page-heading"><div><small>{eyebrow}</small><h1>{title}</h1><p>{description}</p></div>{actions && <div className="rc-heading-actions">{actions}</div>}</header>;
}
