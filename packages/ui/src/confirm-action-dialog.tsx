"use client";

import { useEffect, useRef, useState } from "react";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

export function ConfirmActionDialog({
  open, title, description, confirmLabel, reasonLabel, reasonPlaceholder, busy = false, onCancel, onConfirm,
}: {
  open: boolean; title: string; description: string; confirmLabel: string; busy?: boolean;
  reasonLabel?: string; reasonPlaceholder?: string;
  onCancel: () => void; onConfirm: (reason: string) => void;
}) {
  const { t } = useAppLocale();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    let frame = 0;
    if (open && !dialog.open) {
      setReason("");
      dialog.showModal();
      frame = window.requestAnimationFrame(() => (reasonLabel ? reasonRef.current : confirmRef.current)?.focus());
    } else if (!open && dialog.open) dialog.close();
    return () => window.cancelAnimationFrame(frame);
  }, [open, reasonLabel]);
  return <dialog ref={dialogRef} className="rc-dialog" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }} onClose={() => { if (open && !busy) onCancel(); }}>
    <form method="dialog" onSubmit={(event) => { event.preventDefault(); if ((!reasonLabel || reason.trim()) && !busy) onConfirm(reason.trim()); }}>
      <header><small>{t("敏感操作确认")}</small><h2>{t(title)}</h2><p>{t(description)}</p></header>
      {reasonLabel ? <label>{t(reasonLabel)}<textarea ref={reasonRef} required maxLength={500} rows={4} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t(reasonPlaceholder ?? "请填写本次业务决定的依据")} /></label> : null}
      <footer>
        <button className="rc-button" type="button" disabled={busy} onClick={onCancel}>{t("取消")}</button>
        <button ref={confirmRef} className="rc-primary" type="submit" disabled={busy || Boolean(reasonLabel && !reason.trim())}>{busy ? t("正在提交…") : t(confirmLabel)}</button>
      </footer>
    </form>
  </dialog>;
}
