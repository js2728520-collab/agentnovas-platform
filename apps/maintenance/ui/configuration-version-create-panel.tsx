"use client";

import { useState } from "react";

import type { ConfigurationAudience, ConfigurationKind } from "@/lib/versioned-configuration-domain";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { configurationAudiences, configurationKinds, parseConfigurationPayload } from "./configuration-version-ui";

type DraftCommand = {
  kind: ConfigurationKind;
  key: string;
  audience: ConfigurationAudience;
  schemaVersion: number;
  payload: Record<string, unknown>;
  reason: string;
};

export function ConfigurationVersionCreatePanel({ busy, onCreate, report }: {
  busy: boolean;
  onCreate: (command: DraftCommand) => Promise<void>;
  report: (message: string) => void;
}) {
  const [kind, setKind] = useState<ConfigurationKind>("feature_flag");
  const [audience, setAudience] = useState<ConfigurationAudience>("shared");
  const [key, setKey] = useState("platform.example");
  const [schemaVersion, setSchemaVersion] = useState(1);
  const [payload, setPayload] = useState("{\n  \"enabled\": false\n}");
  const [reason, setReason] = useState("");

  async function submit() {
    try {
      await onCreate({ kind, key, audience, schemaVersion, payload: parseConfigurationPayload(payload), reason });
      setReason("");
    } catch (error) {
      report(error instanceof Error ? error.message : "配置草稿创建失败");
    }
  }

  const validKey = /^[a-z][a-z0-9_.-]{2,120}$/.test(key.trim());
  return <section className="rc-panel">
    <header><div><small>IMMUTABLE DRAFT</small><h2>创建配置草稿</h2><p>普通草稿会直接创建并记录原因；内容创建后不可覆盖，修改请创建下一版本。</p></div></header>
    <div className="rc-form rc-form-grid">
      <label>配置类型<select value={kind} onChange={(event) => setKind(event.target.value as ConfigurationKind)}>{configurationKinds.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>作用端<select value={audience} onChange={(event) => setAudience(event.target.value as ConfigurationAudience)}>{configurationAudiences.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>配置 key<input spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder="feature.paper_trading" /><small>小写字母开头，可使用数字、点、下划线和连字符。</small></label>
      <label>Schema 版本<input type="number" min={1} max={1_000_000} value={schemaVersion} onChange={(event) => setSchemaVersion(Number(event.target.value))} /></label>
      <label className="rc-wide-field">非秘密 JSON payload<textarea spellCheck={false} rows={9} value={payload} onChange={(event) => setPayload(event.target.value)} /><small>不能保存 secret、password、token、API key、private key 或凭证字段，最大 64 KiB。</small></label>
      <InlineAuditReasonField id="configuration-draft-reason" value={reason} onChange={setReason} label="草稿创建原因" />
      <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !validKey || !hasValidAuditReason(reason)} onClick={() => void submit()}>{busy ? "正在创建…" : "直接创建草稿"}</button></div>
    </div>
  </section>;
}
