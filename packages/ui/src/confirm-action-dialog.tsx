"use client";

import { useEffect, useRef, useState } from "react";

export function ConfirmActionDialog({
  open, title, description, confirmLabel, busy = false, onCancel, onConfirm,
}: {
  open: boolean; title: string; description: string; confirmLabel: string; busy?: boolean;
  onCancel: () => void; onConfirm: (reason: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    let frame = 0;
    if (open && !dialog.open) {
      setReason("");
      dialog.showModal();
      frame = window.requestAnimationFrame(() => reasonRef.current?.focus());
    } else if (!open && dialog.open) dialog.close();
    return () => window.cancelAnimationFrame(frame);
  }, [open]);
  return <dialog ref={dialogRef} className="rc-dialog" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }} onClose={() => { if (open && !busy) onCancel(); }}>
    <form method="dialog" onSubmit={(event) => { event.preventDefault(); if (reason.trim() && !busy) onConfirm(reason.trim()); }}>
      <header><small>敏感操作确认</small><h2>{title}</h2><p>{description}</p></header>
      <label>操作原因<textarea ref={reasonRef} required maxLength={500} rows={4} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="请记录可审计的业务原因" /></label>
      <footer>
        <button className="rc-button" type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button className="rc-primary" type="submit" disabled={busy || !reason.trim()}>{busy ? "正在提交…" : confirmLabel}</button>
      </footer>
    </form>
  </dialog>;
}
