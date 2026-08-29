"use client";

import { useState } from "react";

import type { PaymentEvidenceInput } from "./commercial-workspace-types";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

export function PaymentEvidenceForm({
  currency,
  busy,
  onCancel,
  onSubmit,
}: {
  currency: "USD" | "USDT";
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: PaymentEvidenceInput) => void;
}) {
  const { t } = useAppLocale();
  const [form, setForm] = useState({
    evidenceKind: "bank_transfer" as PaymentEvidenceInput["evidenceKind"],
    providerLabel: "",
    reference: "",
    amount: "",
    occurredAt: new Date().toISOString().slice(0, 16),
    note: "",
  });

  return (
    <section className="rc-panel" aria-labelledby="payment-evidence-title">
      <header>
        <div>
          <small>EXTERNAL PAYMENT EVIDENCE</small>
          <h2 id="payment-evidence-title">{t("记录外部付款凭证")}</h2>
          <p>{t("凭证只记录外部付款事实，保存不代表审批或资金执行。")}</p>
        </div>
      </header>
      <form
        className="rc-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          onSubmit({
            ...form,
            providerLabel: form.providerLabel.trim(),
            reference: form.reference.trim(),
            amount: form.amount.trim(),
            occurredAt: new Date(form.occurredAt).toISOString(),
            note: form.note.trim(),
            currency,
          });
        }}
      >
        <label>
          {t("凭证类型")}
          <select
            value={form.evidenceKind}
            onChange={(event) => setForm({
              ...form,
              evidenceKind: event.target.value as PaymentEvidenceInput["evidenceKind"],
            })}
          >
            <option value="bank_transfer">{t("银行转账")}</option>
            <option value="manual_invoice">{t("人工账单")}</option>
            <option value="provider_reference">{t("受控服务参考号")}</option>
          </select>
        </label>
        <label>
          {t("渠道标识（非唯一凭据）")}
          <input
            maxLength={80}
            value={form.providerLabel}
            onChange={(event) => setForm({ ...form, providerLabel: event.target.value })}
            placeholder={t("例如 Bank Wire")}
          />
        </label>
        <label>
          {t("外部参考号")}
          <input
            required
            maxLength={256}
            autoComplete="off"
            value={form.reference}
            onChange={(event) => setForm({ ...form, reference: event.target.value })}
          />
        </label>
        <label>
          {t("金额")}（{currency}）
          <input
            required
            inputMode="decimal"
            pattern="[0-9]+(?:\\.[0-9]{1,18})?"
            value={form.amount}
            onChange={(event) => setForm({ ...form, amount: event.target.value })}
          />
        </label>
        <label>
          {t("外部付款时间")}
          <input
            required
            type="datetime-local"
            value={form.occurredAt}
            onChange={(event) => setForm({ ...form, occurredAt: event.target.value })}
          />
        </label>
        <label>
          {t("记录原因")}
          <textarea
            required
            maxLength={500}
            rows={3}
            value={form.note}
            onChange={(event) => setForm({ ...form, note: event.target.value })}
            placeholder={t("写明核对来源和业务依据")}
          />
        </label>
        <div className="rc-action-row">
          <button className="rc-button" type="button" disabled={busy} onClick={onCancel}>
            {t("取消")}
          </button>
          <button className="rc-primary" type="submit" disabled={busy}>
            {busy ? t("正在记录…") : t("确认记录凭证")}
          </button>
        </div>
      </form>
    </section>
  );
}
