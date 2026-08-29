import type { AppAudience } from "./riverton-apps.ts";
import { defaultUserAppPreference, localeOptionsForAudience, type UserAppLocale } from "./user-app-preference.ts";

export function preferenceLocaleCookieName(audience: AppAudience) {
  return `rv_locale_${audience}`;
}

function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function supportedLocale(value: string | null, audience: AppAudience): UserAppLocale | null {
  if (!value) return null;
  const allowed = localeOptionsForAudience(audience);
  const exact = allowed.find((locale) => locale.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const language = value.split("-")[0]?.toLowerCase();
  return allowed.find((locale) => locale.split("-")[0]?.toLowerCase() === language) ?? null;
}

export function requestInitialAppLocale(requestHeaders: Headers, audience: AppAudience): UserAppLocale {
  const saved = supportedLocale(
    cookieValue(requestHeaders.get("cookie") ?? "", preferenceLocaleCookieName(audience)),
    audience,
  );
  if (saved) return saved;
  if (audience === "client") {
    const requested = (requestHeaders.get("accept-language") ?? "")
      .split(",")
      .map((part) => {
        const [tag, weight] = part.trim().split(";q=");
        return { tag, weight: weight === undefined ? 1 : Number(weight) };
      })
      .filter((entry) => entry.tag && Number.isFinite(entry.weight))
      .sort((left, right) => right.weight - left.weight)
      .map((entry) => supportedLocale(entry.tag, audience))
      .find((locale): locale is UserAppLocale => Boolean(locale));
    if (requested) return requested;
  }
  return defaultUserAppPreference(audience).locale;
}
