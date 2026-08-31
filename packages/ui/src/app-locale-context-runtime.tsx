"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  use,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

import type { AppAudience } from "@/lib/riverton-apps";
import {
  defaultUserAppPreference,
  localeOptionsForAudience,
  type UserAppLocale,
} from "@/lib/user-app-preference";
import { localizeLoginText } from "./app-login-locale";

type LocaleContextValue = {
  audience: AppAudience;
  locale: UserAppLocale;
  t: (text: string) => string;
};

type LocalizeAppText = (value: string, locale: UserAppLocale) => string;

const AppLocaleContext = createContext<LocaleContextValue | null>(null);
let localizedTextPromise: Promise<LocalizeAppText> | null = null;

function loadLocalizedText() {
  localizedTextPromise ??= import("./app-locale-context")
    .then((module) => module.localizeAppText);
  return localizedTextPromise;
}

function IdentityLocaleProvider({ audience, locale, children }: {
  audience: AppAudience;
  locale: UserAppLocale;
  children: ReactNode;
}) {
  const t = useCallback((text: string) => text, []);
  const value = useMemo(() => ({ audience, locale, t }), [audience, locale, t]);
  return <AppLocaleContext.Provider value={value}>{children}</AppLocaleContext.Provider>;
}

function LoginLocaleProvider({ audience, locale, children }: {
  audience: AppAudience;
  locale: UserAppLocale;
  children: ReactNode;
}) {
  const t = useCallback((text: string) => localizeLoginText(text, locale), [locale]);
  const value = useMemo(() => ({ audience, locale, t }), [audience, locale, t]);
  return <AppLocaleContext.Provider value={value}>{children}</AppLocaleContext.Provider>;
}

function DeferredLocaleProvider({ audience, locale, children }: {
  audience: AppAudience;
  locale: UserAppLocale;
  children: ReactNode;
}) {
  const localize = use(loadLocalizedText());
  const t = useCallback((text: string) => localize(text, locale), [localize, locale]);
  const value = useMemo(() => ({ audience, locale, t }), [audience, locale, t]);
  return <AppLocaleContext.Provider value={value}>{children}</AppLocaleContext.Provider>;
}

export function AppLocaleProvider({ audience, initialLocale, children }: {
  audience: AppAudience;
  initialLocale?: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const locale = useMemo(() => {
    const allowed = localeOptionsForAudience(audience) as readonly string[];
    return allowed.includes(initialLocale ?? "")
      ? initialLocale as UserAppLocale
      : defaultUserAppPreference(audience).locale;
  }, [audience, initialLocale]);

  if (locale === "zh-CN") {
    return <IdentityLocaleProvider audience={audience} locale={locale}>{children}</IdentityLocaleProvider>;
  }
  if (locale === "en-US" && pathname === "/login") {
    return <LoginLocaleProvider audience={audience} locale={locale}>{children}</LoginLocaleProvider>;
  }
  return <DeferredLocaleProvider audience={audience} locale={locale}>{children}</DeferredLocaleProvider>;
}

export function useAppLocale() {
  const value = useContext(AppLocaleContext);
  if (!value) throw new Error("useAppLocale must be used within AppLocaleProvider");
  return value;
}
