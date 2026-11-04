/**
 * Interface language for this device. The choice is a per-device preference
 * (like the color scheme), kept in local storage. "system" follows the
 * browser's preferred languages and falls back to English.
 */

export const SUPPORTED_LOCALES = ["en", "ru", "es", "zh-CN"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LocalePreference = Locale | "system";

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "specwithcode:locale";

/** Each language names itself, so a person can find theirs whatever is showing. */
export const LOCALE_NATIVE_NAMES: Readonly<Record<Locale, string>> = {
  en: "English",
  ru: "Русский",
  es: "Español",
  "zh-CN": "简体中文",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || isLocale(value);
}

/** Best supported match for a BCP 47 tag such as `ru-RU`, `es-419` or `zh-Hans-CN`. */
export function matchLocale(tag: string): Locale | null {
  const normalized = tag.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const [language] = normalized.split(/[-_]/);
  switch (language) {
    case "en":
      return "en";
    case "ru":
      return "ru";
    case "es":
      return "es";
    case "zh":
      // Traditional script regions are not translated yet; they still read
      // Simplified Chinese better than English.
      return "zh-CN";
    default:
      return null;
  }
}

export function resolveSystemLocale(languages: ReadonlyArray<string> | undefined): Locale {
  for (const tag of languages ?? []) {
    const match = matchLocale(tag);
    if (match !== null) return match;
  }
  return DEFAULT_LOCALE;
}

export function resolveLocale(
  preference: LocalePreference,
  languages: ReadonlyArray<string> | undefined,
): Locale {
  return preference === "system" ? resolveSystemLocale(languages) : preference;
}

// ── Store ────────────────────────────────────────────────────

const listeners = new Set<() => void>();

function readStoredPreference(): LocalePreference {
  try {
    if (typeof window === "undefined") return "system";
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocalePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function browserLanguages(): ReadonlyArray<string> {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages;
  }
  return navigator.language ? [navigator.language] : [];
}

let preference: LocalePreference = readStoredPreference();
let current: Locale = resolveLocale(preference, browserLanguages());

function applyDocumentLanguage(locale: Locale) {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

function notify() {
  for (const listener of listeners) listener();
}

export function getLocalePreference(): LocalePreference {
  return preference;
}

export function getLocale(): Locale {
  return current;
}

export function setLocalePreference(next: LocalePreference) {
  preference = next;
  try {
    if (next === "system") window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    else window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // Private windows can refuse storage; the choice still applies until reload.
  }
  current = resolveLocale(next, browserLanguages());
  applyDocumentLanguage(current);
  notify();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  applyDocumentLanguage(current);
  window.addEventListener("storage", (event) => {
    if (event.key !== LOCALE_STORAGE_KEY) return;
    preference = readStoredPreference();
    current = resolveLocale(preference, browserLanguages());
    applyDocumentLanguage(current);
    notify();
  });
  window.addEventListener("languagechange", () => {
    if (preference !== "system") return;
    current = resolveLocale(preference, browserLanguages());
    applyDocumentLanguage(current);
    notify();
  });
}
