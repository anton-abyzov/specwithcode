import { useCallback, useSyncExternalStore } from "react";

import {
  DEFAULT_LOCALE,
  getLocale,
  getLocalePreference,
  setLocalePreference,
  subscribeLocale,
  type Locale,
  type LocalePreference,
} from "./locale";
import { en, type MessageKey, type Messages, type PluralMessage } from "./messages/en";
import { es } from "./messages/es";
import { ru } from "./messages/ru";
import { zh } from "./messages/zh";
import { ja } from "./messages/ja";
import { pt } from "./messages/pt";
import { ko } from "./messages/ko";
import { de } from "./messages/de";
import { fr } from "./messages/fr";
import { translatePhrase } from "./phrases";

export * from "./locale";
export type { MessageKey } from "./messages/en";

const CATALOGS: Readonly<Record<Locale, Messages>> = {
  en,
  ru,
  es,
  "zh-CN": zh,
  ja,
  "pt-BR": pt,
  ko,
  de,
  fr,
};

export type MessageValues = Readonly<Record<string, string | number>>;

const pluralRulesCache = new Map<Locale, Intl.PluralRules>();
function pluralRules(locale: Locale) {
  let rules = pluralRulesCache.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

function interpolate(template: string, values: MessageValues | undefined, locale: Locale) {
  if (values === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    if (value === undefined) return match;
    return typeof value === "number" ? value.toLocaleString(locale) : value;
  });
}

function pickPlural(message: PluralMessage, count: number, locale: Locale): string {
  const category = pluralRules(locale).select(count);
  return message[category] ?? message.other;
}

/**
 * Translate `key` for `locale`. Plural messages pick their form from
 * `values.count`. A key missing from a catalog falls back to English, so a
 * partly translated language never shows raw keys.
 */
export function translate(locale: Locale, key: MessageKey, values?: MessageValues): string {
  const catalog = CATALOGS[locale];
  const message = catalog[key] ?? en[key];
  const effectiveLocale = catalog[key] === undefined ? DEFAULT_LOCALE : locale;
  if (typeof message === "string") return interpolate(message, values, effectiveLocale);
  const count = typeof values?.count === "number" ? values.count : 0;
  return interpolate(pickPlural(message, count, effectiveLocale), values, effectiveLocale);
}

/** Translate with the current interface language, outside React. */
export function t(key: MessageKey, values?: MessageValues): string {
  return translate(getLocale(), key, values);
}

export type Translate = (key: MessageKey, values?: MessageValues) => string;

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => DEFAULT_LOCALE);
}

export function useLocalePreference(): readonly [
  LocalePreference,
  (next: LocalePreference) => void,
] {
  const value = useSyncExternalStore(subscribeLocale, getLocalePreference, () => "system" as const);
  return [value, setLocalePreference] as const;
}

/** `t` bound to the current language; the component re-renders when it changes. */
export function useT(): Translate {
  const locale = useLocale();
  return useCallback((key, values) => translate(locale, key, values), [locale]);
}

/**
 * Translate an English UI phrase by its own text, for the many settings rows
 * and labels that are not worth a named key. Unknown phrases stay English.
 * A phrase with `{name}` slots is looked up as written, then filled from `values`.
 */
export type TranslatePhrase = (english: string, values?: MessageValues) => string;

/** A `TranslatePhrase` that keeps English and only fills `{name}` slots. */
export const englishPhrase: TranslatePhrase = (english, values) =>
  interpolate(english, values, DEFAULT_LOCALE);

export function useTx(): TranslatePhrase {
  const locale = useLocale();
  return useCallback(
    (english: string, values?: MessageValues) =>
      interpolate(translatePhrase(locale, english), values, locale),
    [locale],
  );
}
