"use client";

import { useState } from "react";

type Lang = "zh-CN" | "zh-TW" | "en-US" | "ru-RU" | "es-ES" | "ja-JP" | "ko-KR";

export default function SupportFloating({ lang }: { lang: Lang }) {
  const [open, setOpen] = useState(false);
  const zh = lang === "zh-CN" || lang === "zh-TW";
  return <div className={`support-floating ${open ? "open" : ""}`}>
    <button className="support-fab" onClick={() => setOpen(!open)} aria-label={zh ? "联系客服" : "Contact support"}>?</button>
    {open && <section className="support-popover">
      <header><div><b>{zh ? "客服中心" : "Support"}</b><small>{zh ? "工作日在线 · 消息会进入工单" : "Business hours · Messages become support tickets"}</small></div><button onClick={() => setOpen(false)} aria-label={zh ? "关闭" : "Close"}>×</button></header>
      <p>{zh ? "请留下问题和联系方式，客服会按工单顺序回复。不要发送 API 密钥、Secret 或密码。" : "Describe your issue and preferred contact channel. Never send API keys, secrets or passwords here."}</p>
      <textarea placeholder={zh ? "请输入问题" : "Describe your question"} />
      <button className="primary" onClick={() => setOpen(false)}>{zh ? "提交工单" : "Create ticket"}</button>
    </section>}
  </div>;
}
