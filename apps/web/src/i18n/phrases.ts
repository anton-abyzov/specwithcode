import type { Locale } from "./locale";
import { de } from "./phrases/de";
import { es } from "./phrases/es";
import { fr } from "./phrases/fr";
import { ja } from "./phrases/ja";
import { ko } from "./phrases/ko";
import { pt } from "./phrases/pt";
import { ru } from "./phrases/ru";
import { zh } from "./phrases/zh";

/** English phrase to its translation. A phrase a catalog lacks shows in English. */
export type PhraseCatalog = Readonly<Record<string, string>>;

const PHRASES: Readonly<Partial<Record<Locale, PhraseCatalog>>> = {
  ru,
  es,
  "zh-CN": zh,
  ja,
  "pt-BR": pt,
  ko,
  de,
  fr,
};

export function translatePhrase(locale: Locale, english: string): string {
  const catalog = PHRASES[locale];
  return catalog !== undefined && Object.hasOwn(catalog, english) ? catalog[english]! : english;
}
