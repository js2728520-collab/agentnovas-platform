"use client";

import { useEffect, useMemo, useState } from "react";

import type { AppAudience } from "@/lib/riverton-apps";
import {
  defaultUserAppPreference,
  localeOptionsForAudience,
  type UserAppLocale,
  type UserAppPreference,
  type UserThemeMode,
  type UserThemePalette,
} from "@/lib/user-app-preference";
import { apiErrorMessage } from "@/packages/contracts/src/riverton-ui";
import {
  PALETTE_STORAGE_KEY,
  PLATFORM_LOCALE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  appLocaleCookieName,
} from "./theme-script";
import { ErrorState, LoadingState, PageHeading } from "./page-state";

const localeNames: Record<UserAppLocale, string> = {
  "en-US": "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  "ru-RU": "Русский",
  "es-ES": "Español",
  "ja-JP": "日本語",
  "ko-KR": "한국어",
};

type Copy = {
  eyebrow: string; title: string; description: string;
  language: string; languageDescription: string;
  mode: string; modeDescription: string; palette: string; paletteDescription: string;
  system: string; light: string; dark: string; classic: string; harbor: string; forest: string;
  reset: string; save: string; saving: string; saved: string; retry: string;
};

const copies: Record<UserAppLocale, Copy> = {
  "zh-CN": {
    eyebrow: "APPEARANCE & LANGUAGE", title: "外观与语言", description: "语言、明暗模式和调色板按当前应用独立保存。业务状态色不会随调色板改变。",
    language: "界面语言", languageDescription: "客户端支持七种语言；内部端仅提供简体中文和英语。",
    mode: "明暗模式", modeDescription: "跟随系统会使用当前设备的显示偏好。",
    palette: "调色板", paletteDescription: "三组调色板分别适配浅色和深色，共六套主题。",
    system: "跟随系统", light: "浅色", dark: "深色", classic: "经典", harbor: "海湾", forest: "松林",
    reset: "恢复默认", save: "保存设置", saving: "保存中…", saved: "设置已保存。", retry: "读取偏好失败",
  },
  "zh-TW": {
    eyebrow: "APPEARANCE & LANGUAGE", title: "外觀與語言", description: "語言、明暗模式與調色盤會按目前應用程式分開儲存，業務狀態色不會改變。",
    language: "介面語言", languageDescription: "客戶端支援七種語言；內部端僅提供簡體中文與英文。",
    mode: "明暗模式", modeDescription: "跟隨系統會使用目前裝置的顯示偏好。",
    palette: "調色盤", paletteDescription: "三組調色盤各有淺色與深色，共六套主題。",
    system: "跟隨系統", light: "淺色", dark: "深色", classic: "經典", harbor: "海灣", forest: "松林",
    reset: "恢復預設", save: "儲存設定", saving: "儲存中…", saved: "設定已儲存。", retry: "讀取偏好失敗",
  },
  "en-US": {
    eyebrow: "APPEARANCE & LANGUAGE", title: "Appearance and language", description: "Language, display mode, and palette are stored separately for this application. Status colors do not change.",
    language: "Interface language", languageDescription: "Client supports seven languages; internal applications support Chinese and English.",
    mode: "Display mode", modeDescription: "System mode follows this device's display preference.",
    palette: "Color palette", paletteDescription: "Three palettes pair with light and dark modes to provide six themes.",
    system: "System", light: "Light", dark: "Dark", classic: "Classic", harbor: "Harbor", forest: "Forest",
    reset: "Restore defaults", save: "Save settings", saving: "Saving…", saved: "Settings saved.", retry: "Unable to load preferences",
  },
  "ru-RU": {
    eyebrow: "APPEARANCE & LANGUAGE", title: "Внешний вид и язык", description: "Язык, режим и палитра сохраняются отдельно для этого приложения. Цвета состояний не меняются.",
    language: "Язык интерфейса", languageDescription: "Клиент поддерживает семь языков; внутренние приложения — китайский и английский.",
    mode: "Режим отображения", modeDescription: "Системный режим следует настройкам устройства.",
    palette: "Цветовая палитра", paletteDescription: "Три палитры в светлом и тёмном режимах образуют шесть тем.",
    system: "Системный", light: "Светлый", dark: "Тёмный", classic: "Классика", harbor: "Гавань", forest: "Лес",
    reset: "По умолчанию", save: "Сохранить", saving: "Сохранение…", saved: "Настройки сохранены.", retry: "Не удалось загрузить настройки",
  },
  "es-ES": {
    eyebrow: "APPEARANCE & LANGUAGE", title: "Apariencia e idioma", description: "El idioma, el modo y la paleta se guardan por separado para esta aplicación. Los colores de estado no cambian.",
    language: "Idioma de la interfaz", languageDescription: "El cliente admite siete idiomas; las aplicaciones internas, chino e inglés.",
    mode: "Modo de visualización", modeDescription: "El modo del sistema sigue la preferencia del dispositivo.",
    palette: "Paleta de colores", paletteDescription: "Tres paletas combinadas con modos claro y oscuro ofrecen seis temas.",
    system: "Sistema", light: "Claro", dark: "Oscuro", classic: "Clásica", harbor: "Puerto", forest: "Bosque",
    reset: "Restablecer", save: "Guardar ajustes", saving: "Guardando…", saved: "Ajustes guardados.", retry: "No se pudieron cargar las preferencias",
  },
  "ja-JP": {
    eyebrow: "APPEARANCE & LANGUAGE", title: "外観と言語", description: "言語、表示モード、配色はこのアプリごとに保存されます。状態色は変わりません。",
    language: "表示言語", languageDescription: "クライアントは7言語、社内アプリは中国語と英語に対応します。",
    mode: "表示モード", modeDescription: "システム設定では端末の表示設定に従います。",
    palette: "カラーパレット", paletteDescription: "3つの配色とライト／ダークで6テーマを提供します。",
    system: "システム", light: "ライト", dark: "ダーク", classic: "クラシック", harbor: "ハーバー", forest: "フォレスト",
    reset: "初期設定に戻す", save: "設定を保存", saving: "保存中…", saved: "設定を保存しました。", retry: "設定を読み込めませんでした",
  },
  "ko-KR": {
    eyebrow: "APPEARANCE & LANGUAGE", title: "화면 및 언어", description: "언어, 표시 모드, 팔레트는 현재 앱별로 저장됩니다. 상태 색상은 변경되지 않습니다.",
    language: "인터페이스 언어", languageDescription: "클라이언트는 7개 언어, 내부 앱은 중국어와 영어를 지원합니다.",
    mode: "표시 모드", modeDescription: "시스템 모드는 기기의 표시 설정을 따릅니다.",
    palette: "색상 팔레트", paletteDescription: "세 팔레트와 밝은/어두운 모드로 여섯 가지 테마를 제공합니다.",
    system: "시스템", light: "라이트", dark: "다크", classic: "클래식", harbor: "하버", forest: "포레스트",
    reset: "기본값 복원", save: "설정 저장", saving: "저장 중…", saved: "설정을 저장했습니다.", retry: "환경설정을 불러오지 못했습니다",
  },
};

const modes: UserThemeMode[] = ["system", "light", "dark"];
const palettes: UserThemePalette[] = ["classic", "harbor", "forest"];

function applyPreference(preference: UserAppPreference, persist: boolean, audience?: AppAudience) {
  const root = document.documentElement;
  if (preference.themeMode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference.themeMode);
  if (preference.themePalette === "classic") root.removeAttribute("data-palette");
  else root.setAttribute("data-palette", preference.themePalette);
  root.lang = preference.locale;
  if (!persist) return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference.themeMode);
    localStorage.setItem(PALETTE_STORAGE_KEY, preference.themePalette);
    localStorage.setItem(PLATFORM_LOCALE_STORAGE_KEY, preference.locale);
    if (audience) document.cookie = `${appLocaleCookieName(audience)}=${encodeURIComponent(preference.locale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {
    // 浏览器拒绝持久化时，当前页面仍保持所选外观。
  }
}

function editablePreference(preference: UserAppPreference): UserAppPreference {
  return {
    locale: preference.locale,
    themeMode: preference.themeMode,
    themePalette: preference.themePalette,
  };
}

export function AppPreferenceSettings({ audience }: { audience: AppAudience }) {
  const fallback = useMemo(() => defaultUserAppPreference(audience), [audience]);
  const [saved, setSaved] = useState<UserAppPreference>(fallback);
  const [draft, setDraft] = useState<UserAppPreference>(fallback);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const copy = copies[draft.locale] ?? copies[audience === "client" ? "en-US" : "zh-CN"];

  async function load() {
    setLoaded(false);
    setError("");
    try {
      const response = await fetch("/api/account/preferences", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.preference) throw new Error(apiErrorMessage(body, copy.retry));
      const preference = editablePreference(body.preference as UserAppPreference);
      setSaved(preference);
      setDraft(preference);
      applyPreference(preference, true, audience);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.retry);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [audience]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(patch: Partial<UserAppPreference>) {
    setMessage("");
    setDraft((current) => {
      const next = { ...current, ...patch };
      applyPreference(next, false);
      return next;
    });
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/account/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locale: draft.locale,
          themeMode: draft.themeMode,
          themePalette: draft.themePalette,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.preference) throw new Error(apiErrorMessage(body, copy.retry));
      const preference = editablePreference(body.preference as UserAppPreference);
      const localeChanged = preference.locale !== saved.locale;
      setSaved(preference);
      setDraft(preference);
      applyPreference(preference, true, audience);
      setMessage(copy.saved);
      if (localeChanged) window.location.reload();
    } catch (reason) {
      applyPreference(saved, true, audience);
      setDraft(saved);
      setError(reason instanceof Error ? reason.message : copy.retry);
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <LoadingState label={copy.languageDescription} />;
  if (error && JSON.stringify(saved) === JSON.stringify(fallback)) return <ErrorState message={error} retry={() => void load()} />;

  return <>
    <PageHeading eyebrow={copy.eyebrow} title={copy.title} description={copy.description} />
    <div className="rc-live" role="status" aria-live="polite">{message}</div>
    {error ? <div className="rc-warning" role="alert">{error}</div> : null}
    <section className="rc-panel rc-preference-section" aria-labelledby="preference-language-title">
      <header><div><small>LANGUAGE</small><h2 id="preference-language-title">{copy.language}</h2><p>{copy.languageDescription}</p></div></header>
      <label className="rc-preference-language">{copy.language}<select value={draft.locale} disabled={saving} onChange={(event) => update({ locale: event.target.value as UserAppLocale })}>
        {localeOptionsForAudience(audience).map((locale) => <option key={locale} value={locale}>{localeNames[locale]}</option>)}
      </select></label>
    </section>
    <section className="rc-panel rc-preference-section" aria-labelledby="preference-mode-title">
      <header><div><small>THEME MODE</small><h2 id="preference-mode-title">{copy.mode}</h2><p>{copy.modeDescription}</p></div></header>
      <div className="rc-preference-options" role="radiogroup" aria-label={copy.mode}>
        {modes.map((mode) => <button key={mode} type="button" role="radio" aria-checked={draft.themeMode === mode} className={draft.themeMode === mode ? "selected" : undefined} disabled={saving} onClick={() => update({ themeMode: mode })}>
          <span className={`rc-mode-preview is-${mode}`} aria-hidden="true"><i /><i /></span><b>{copy[mode]}</b>
        </button>)}
      </div>
    </section>
    <section className="rc-panel rc-preference-section" aria-labelledby="preference-palette-title">
      <header><div><small>COLOR PALETTE</small><h2 id="preference-palette-title">{copy.palette}</h2><p>{copy.paletteDescription}</p></div></header>
      <div className="rc-preference-options" role="radiogroup" aria-label={copy.palette}>
        {palettes.map((palette) => <button key={palette} type="button" role="radio" aria-checked={draft.themePalette === palette} className={draft.themePalette === palette ? "selected" : undefined} disabled={saving} onClick={() => update({ themePalette: palette })}>
          <span className={`rc-palette-preview is-${palette}`} aria-hidden="true"><i /><i /><i /></span><b>{copy[palette]}</b>
        </button>)}
      </div>
      <footer className="rc-action-row"><button className="rc-button" type="button" disabled={saving} onClick={() => update(defaultUserAppPreference(audience))}>{copy.reset}</button><button className="rc-primary" type="button" disabled={saving || JSON.stringify(draft) === JSON.stringify(saved)} onClick={() => void save()}>{saving ? copy.saving : copy.save}</button></footer>
    </section>
  </>;
}
