import type { AppAudience } from "./riverton-apps.ts";
import { supportedPlatformLocales, type PlatformLocale } from "./platform-locale.ts";

export const userThemeModes = ["system", "light", "dark"] as const;
export const userThemePalettes = ["classic", "harbor", "forest"] as const;
export const internalAppLocales = ["zh-CN", "en-US"] as const;

export type UserThemeMode = typeof userThemeModes[number];
export type UserThemePalette = typeof userThemePalettes[number];
export type InternalAppLocale = typeof internalAppLocales[number];
export type UserAppLocale = PlatformLocale | InternalAppLocale;

export type UserAppPreference = {
  locale: UserAppLocale;
  themeMode: UserThemeMode;
  themePalette: UserThemePalette;
};

export type UserAppPreferencePatch = Partial<UserAppPreference>;

export class UserAppPreferenceValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "UserAppPreferenceValidationError";
    this.code = code;
  }
}
export function localeOptionsForAudience(audience: AppAudience): readonly UserAppLocale[] {
  return audience === "client" ? supportedPlatformLocales : internalAppLocales;
}

export function defaultUserAppPreference(
  audience: AppAudience,
  legacyLocale?: string | null,
): UserAppPreference {
  const allowed = localeOptionsForAudience(audience);
  const legacy = typeof legacyLocale === "string" && allowed.includes(legacyLocale as UserAppLocale)
    ? legacyLocale as UserAppLocale
    : null;
  return {
    locale: legacy ?? (audience === "client" ? "en-US" : "zh-CN"),
    themeMode: "system",
    themePalette: "classic",
  };
}

function recordInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new UserAppPreferenceValidationError("PREFERENCE_BODY_INVALID");
  }
  return input as Record<string, unknown>;
}

export function normalizeUserAppPreferencePatch(
  audience: AppAudience,
  input: unknown,
): UserAppPreferencePatch {
  const source = recordInput(input);
  const allowedFields = new Set(["locale", "themeMode", "themePalette"]);
  if (Object.keys(source).some((key) => !allowedFields.has(key))) {
    throw new UserAppPreferenceValidationError("PREFERENCE_FIELD_INVALID");
  }
  const patch: UserAppPreferencePatch = {};
  if (Object.hasOwn(source, "locale")) {
    if (typeof source.locale !== "string"
      || !localeOptionsForAudience(audience).includes(source.locale as UserAppLocale)) {
      throw new UserAppPreferenceValidationError("PREFERENCE_LOCALE_INVALID");
    }
    patch.locale = source.locale as UserAppLocale;
  }
  if (Object.hasOwn(source, "themeMode")) {
    if (typeof source.themeMode !== "string"
      || !userThemeModes.includes(source.themeMode as UserThemeMode)) {
      throw new UserAppPreferenceValidationError("PREFERENCE_THEME_MODE_INVALID");
    }
    patch.themeMode = source.themeMode as UserThemeMode;
  }
  if (Object.hasOwn(source, "themePalette")) {
    if (typeof source.themePalette !== "string"
      || !userThemePalettes.includes(source.themePalette as UserThemePalette)) {
      throw new UserAppPreferenceValidationError("PREFERENCE_THEME_PALETTE_INVALID");
    }
    patch.themePalette = source.themePalette as UserThemePalette;
  }
  if (!Object.keys(patch).length) {
    throw new UserAppPreferenceValidationError("PREFERENCE_PATCH_EMPTY");
  }
  return patch;
}
