"use client";

import { useEffect, useMemo, useState } from "react";

type Locale = "zh-CN" | "en-US" | "ru-RU" | "es-ES" | "ja-JP" | "ko-KR";
type Copy = {
  eyebrow: string;
  title: string;
  intro: string;
  toggle: string;
  on: string;
  off: string;
  onDetail: string;
  offDetail: string;
  privateDetail: string;
  save: string;
  saving: string;
  loading: string;
  saved: string;
  failed: string;
};

const copies: Record<Locale, Copy> = {
  "zh-CN": {
    eyebrow: "FOLLOW POLICY",
    title: "策略跟随权限",
    intro: "控制平台 AI 策略和策略广场策略的提现授权要求。默认关闭，客户必须在创建 API 账户时开启提现授权才能跟随。",
    toggle: "允许未开启提现授权的账户跟随",
    on: "已开启",
    off: "已关闭",
    onDetail: "开启后允许客户先跟随，系统标记为每周人工催收；关闭后恢复提现授权强制要求。",
    offDetail: "关闭时，平台 AI 策略和策略广场策略只能由已开启提现授权的账户跟随。",
    privateDetail: "客户自建且不发布到策略广场的策略，绑定自己的交易账户时不受此开关限制。",
    save: "保存规则",
    saving: "保存中…",
    loading: "正在读取规则…",
    saved: "策略跟随权限规则已保存",
    failed: "无法读取或保存策略跟随规则",
  },
  "en-US": {
    eyebrow: "FOLLOW POLICY",
    title: "Strategy follow permissions",
    intro: "Control withdrawal authorization for platform AI and marketplace strategies. It is off by default, so an API account must enable withdrawal authorization before following.",
    toggle: "Allow accounts without withdrawal authorization to follow",
    on: "Enabled",
    off: "Disabled",
    onDetail: "When enabled, customers may follow first and are marked for weekly manual collection; disabling restores the mandatory authorization.",
    offDetail: "When disabled, platform AI and marketplace strategies can only be followed by accounts with withdrawal authorization enabled.",
    privateDetail: "A customer’s private strategy that is not published to the marketplace remains exempt when bound to that customer’s own account.",
    save: "Save policy",
    saving: "Saving…",
    loading: "Loading policy…",
    saved: "Strategy follow policy saved",
    failed: "Unable to read or save the strategy follow policy",
  },
  "ru-RU": {
    eyebrow: "FOLLOW POLICY",
    title: "Правила подписки на стратегии",
    intro: "Управляет требованием разрешения на вывод для платформенных ИИ- и рыночных стратегий. По умолчанию выключено: перед подпиской разрешение должно быть включено в API-аккаунте.",
    toggle: "Разрешить подписку без разрешения на вывод",
    on: "Включено",
    off: "Выключено",
    onDetail: "При включении разрешается подписка с последующим еженедельным ручным взысканием; при выключении разрешение снова обязательно.",
    offDetail: "При выключении платформенные ИИ- и рыночные стратегии доступны только аккаунтам с разрешением на вывод.",
    privateDetail: "Личная стратегия клиента, не опубликованная на рынке, не ограничивается этим правилом при привязке к собственному аккаунту.",
    save: "Сохранить правило",
    saving: "Сохранение…",
    loading: "Загрузка правила…",
    saved: "Правило подписки сохранено",
    failed: "Не удалось прочитать или сохранить правило подписки",
  },
  "es-ES": {
    eyebrow: "FOLLOW POLICY",
    title: "Permisos para seguir estrategias",
    intro: "Controla la autorización de retiros para las estrategias de IA y del mercado. Está desactivado por defecto: la cuenta API debe habilitarla antes de seguir.",
    toggle: "Permitir seguir sin autorización de retiros",
    on: "Activado",
    off: "Desactivado",
    onDetail: "Al activarlo se permite seguir primero y se marca para cobro manual semanal; al desactivarlo vuelve a ser obligatoria la autorización.",
    offDetail: "Con la opción desactivada, solo las cuentas con autorización de retiros pueden seguir estrategias de IA o del mercado.",
    privateDetail: "La estrategia privada del cliente que no se publique en el mercado queda exenta al vincularse a su propia cuenta.",
    save: "Guardar regla",
    saving: "Guardando…",
    loading: "Cargando regla…",
    saved: "Regla de seguimiento guardada",
    failed: "No se pudo leer o guardar la regla de seguimiento",
  },
  "ja-JP": {
    eyebrow: "FOLLOW POLICY",
    title: "戦略フォロー権限",
    intro: "プラットフォームAI戦略とマーケット戦略の出金権限要件を管理します。初期状態はオフで、フォロー前にAPI口座で出金権限を有効にする必要があります。",
    toggle: "出金権限なしの口座によるフォローを許可",
    on: "有効",
    off: "無効",
    onDetail: "有効時は先にフォローできますが、毎週の手動回収対象になります。無効にすると出金権限が必須に戻ります。",
    offDetail: "無効時は、出金権限を有効にした口座だけがプラットフォームAI・マーケット戦略をフォローできます。",
    privateDetail: "マーケットに公開しない自作のプライベート戦略を本人の口座に紐付ける場合、この設定の対象外です。",
    save: "ルールを保存",
    saving: "保存中…",
    loading: "ルールを読み込み中…",
    saved: "戦略フォロールールを保存しました",
    failed: "戦略フォロールールを読み込めませんでした",
  },
  "ko-KR": {
    eyebrow: "FOLLOW POLICY",
    title: "전략 팔로우 권한",
    intro: "플랫폼 AI 전략과 마켓 전략의 출금 권한 요건을 제어합니다. 기본값은 꺼짐이며, 팔로우 전에 API 계정에서 출금 권한을 켜야 합니다.",
    toggle: "출금 권한이 없는 계정의 팔로우 허용",
    on: "켜짐",
    off: "꺼짐",
    onDetail: "켜면 먼저 팔로우할 수 있지만 매주 수동 추심 대상으로 표시됩니다. 끄면 출금 권한이 다시 필수가 됩니다.",
    offDetail: "끄면 출금 권한을 켠 계정만 플랫폼 AI 및 마켓 전략을 팔로우할 수 있습니다.",
    privateDetail: "마켓에 공개하지 않은 고객의 개인 전략을 본인 계정에 연결하는 경우에는 이 설정의 제한을 받지 않습니다.",
    save: "규칙 저장",
    saving: "저장 중…",
    loading: "규칙을 불러오는 중…",
    saved: "전략 팔로우 규칙을 저장했습니다",
    failed: "전략 팔로우 규칙을 읽거나 저장하지 못했습니다",
  },
};

function useLocale() {
  const [locale, setLocale] = useState<Locale>("zh-CN");
  useEffect(() => {
    const read = () => {
      const value = document.documentElement.lang as Locale;
      setLocale(copies[value] ? value : "en-US");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, []);
  return locale;
}

export default function FollowPolicySettings() {
  const locale = useLocale();
  const copy = useMemo(() => copies[locale], [locale]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/admin/follow-policy", { cache: "no-store" }).then(async (response) => {
      const result = await response.json() as { policy?: { allowFollowWithoutWithdrawal?: boolean }; error?: string };
      if (!active) return;
      if (!response.ok) throw new Error(result.error || copy.failed);
      setEnabled(Boolean(result.policy?.allowFollowWithoutWithdrawal));
    }).catch((error) => active && setNotice(error instanceof Error ? error.message : copy.failed)).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [copy.failed]);

  async function save() {
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch("/api/admin/follow-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowFollowWithoutWithdrawal: enabled }),
      });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error || copy.failed);
      setNotice(result.message || copy.saved);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : copy.failed);
    } finally {
      setSaving(false);
    }
  }

  return <section className="wide-panel follow-policy-panel">
    <header><div><small>{copy.eyebrow}</small><h2>{copy.title}</h2><p>{copy.intro}</p></div><span className={enabled ? "policy-status enabled" : "policy-status"}>{enabled ? copy.on : copy.off}</span></header>
    <label className="follow-policy-toggle"><input type="checkbox" checked={enabled} disabled={loading || saving} onChange={(event) => setEnabled(event.target.checked)} /><span><b>{copy.toggle}</b><small>{enabled ? copy.onDetail : copy.offDetail}</small></span></label>
    <p className="follow-policy-private"><i />{copy.privateDetail}</p>
    <div className="follow-policy-actions"><button className="primary" disabled={loading || saving} onClick={() => void save()}>{loading ? copy.loading : saving ? copy.saving : copy.save}</button>{notice && <span className="admin-notice">{notice}</span>}</div>
  </section>;
}
