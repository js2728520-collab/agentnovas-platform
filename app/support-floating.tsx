"use client";

import { useState } from "react";
import Image from "next/image";

type Lang = "zh-CN" | "zh-TW" | "en-US" | "ru-RU" | "es-ES" | "ja-JP" | "ko-KR";

function safeTelegramUrl(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const allowedHosts = new Set(["t.me", "telegram.me", "www.telegram.me", "web.telegram.org"]);
    return url.protocol === "https:" && allowedHosts.has(url.hostname.toLowerCase()) ? url.toString() : "";
  } catch {
    return "";
  }
}

export default function SupportFloating({
  lang,
  telegramUrl,
  supportEmail,
}: {
  lang: Lang;
  telegramUrl?: string;
  supportEmail?: string;
}) {
  const [open, setOpen] = useState(false);
  const zh = lang === "zh-CN" || lang === "zh-TW";
  const telegram = safeTelegramUrl(telegramUrl);
  return <div className={`support-floating ${open ? "open" : ""}`}>
    {telegram
      ? <a className="support-fab" href={telegram} target="_blank" rel="noreferrer" aria-label={zh ? "通过 Telegram 联系客服" : "Contact support on Telegram"}><Image src="/agentnovas-mark-clean.png" width={27} height={27} alt="" /><span>{zh ? "Telegram 客服" : "Telegram support"}</span></a>
      : <button className="support-fab" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={zh ? "联系客服" : "Contact support"}><Image src="/agentnovas-mark-clean.png" width={27} height={27} alt="" /><span>{zh ? "联系客服" : "Contact support"}</span></button>}
    {open && !telegram && <section className="support-popover" role="status">
      <header><div><b>{zh ? "Riverton 客服中心" : "Riverton Support"}</b><small>{zh ? "仅展示已配置的真实联系渠道" : "Only configured contact channels are shown"}</small></div><button type="button" onClick={() => setOpen(false)} aria-label={zh ? "关闭" : "Close"}>×</button></header>
      <p className="support-telegram-unconfigured">{zh ? "Telegram 客服链接尚未配置。" : "The Telegram support link is not configured."}</p>
      {supportEmail
        ? <a className="support-contact-link" href={`mailto:${encodeURIComponent(supportEmail)}`}>{zh ? `发送客服邮件：${supportEmail}` : `Email support: ${supportEmail}`}</a>
        : <p>{zh ? "客服邮箱也尚未配置，请稍后再试。" : "Support email is also unavailable. Please try again later."}</p>}
      <p>{zh ? "请勿通过客服渠道发送 API Key、Secret 或密码。" : "Never send API keys, secrets, or passwords through support channels."}</p>
    </section>}
  </div>;
}
