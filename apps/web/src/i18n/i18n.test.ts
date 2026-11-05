// @vitest-environment jsdom
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { DRIVER_OPTIONS } from "../components/settings/providerDriverMeta";
import { CHAT_OPTION_LABELS, DATE_BUCKETS, THREAD_TONE_LABELS } from "../studio/shellModel";
import { matchLocale, resolveLocale, resolveSystemLocale, SUPPORTED_LOCALES, translate } from ".";
import { de } from "./messages/de";
import { en, type MessageKey } from "./messages/en";
import { es } from "./messages/es";
import { fr } from "./messages/fr";
import { ja } from "./messages/ja";
import { ko } from "./messages/ko";
import { pt } from "./messages/pt";
import { ru } from "./messages/ru";
import { zh } from "./messages/zh";
import { translatePhrase } from "./phrases";
import { de as dePhrases } from "./phrases/de";
import { es as esPhrases } from "./phrases/es";
import { fr as frPhrases } from "./phrases/fr";
import { ja as jaPhrases } from "./phrases/ja";
import { ko as koPhrases } from "./phrases/ko";
import { pt as ptPhrases } from "./phrases/pt";
import { ru as ruPhrases } from "./phrases/ru";
import { zh as zhPhrases } from "./phrases/zh";

const SRC_DIR = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const CATALOGS = { ru, es, "zh-CN": zh, ja, "pt-BR": pt, ko, de, fr } as const;
const PHRASE_CATALOGS = {
  ru: ruPhrases,
  es: esPhrases,
  "zh-CN": zhPhrases,
  ja: jaPhrases,
  "pt-BR": ptPhrases,
  ko: koPhrases,
  de: dePhrases,
  fr: frPhrases,
} as const;

const placeholders = (message: string | Readonly<Record<string, string>>) => {
  const texts = typeof message === "string" ? [message] : Object.values(message);
  return new Set(texts.flatMap((text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1])));
};

describe("locale matching", () => {
  it("maps browser tags to supported languages", () => {
    expect(matchLocale("ru-RU")).toBe("ru");
    expect(matchLocale("es-419")).toBe("es");
    expect(matchLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(matchLocale("zh-TW")).toBe("zh-CN");
    expect(matchLocale("en-GB")).toBe("en");
    expect(matchLocale("ja-JP")).toBe("ja");
    expect(matchLocale("pt-PT")).toBe("pt-BR");
    expect(matchLocale("ko-KR")).toBe("ko");
    expect(matchLocale("de-AT")).toBe("de");
    expect(matchLocale("fr-CA")).toBe("fr");
    expect(matchLocale("it-IT")).toBeNull();
  });

  it("takes the first supported browser language and falls back to English", () => {
    expect(resolveSystemLocale(["it-IT", "ru", "en"])).toBe("ru");
    expect(resolveSystemLocale(["it-IT"])).toBe("en");
    expect(resolveSystemLocale(undefined)).toBe("en");
    expect(resolveLocale("es", ["ru"])).toBe("es");
    expect(resolveLocale("system", ["ru"])).toBe("ru");
  });

  it("lists every catalog", () => {
    expect([...SUPPORTED_LOCALES]).toEqual([
      "en",
      "ru",
      "es",
      "zh-CN",
      "ja",
      "pt-BR",
      "ko",
      "de",
      "fr",
    ]);
  });
});

describe("translate", () => {
  it("fills values and keeps English as the source text", () => {
    expect(translate("en", "wizard.import.selectedCount", { selected: 2, total: 5 })).toBe(
      "2 of 5 selected",
    );
    expect(translate("ru", "limit.error.continueOn", { label: "Codex" })).toBe(
      "Не удалось продолжить на Codex.",
    );
  });

  it("picks plural forms by each language's rules", () => {
    expect(translate("en", "wizard.import.importButton", { count: 1 })).toBe("Import 1 project");
    expect(translate("en", "wizard.import.importButton", { count: 3 })).toBe("Import 3 projects");
    expect(translate("ru", "wizard.import.importButton", { count: 1 })).toBe(
      "Импортировать 1 проект",
    );
    expect(translate("ru", "wizard.import.importButton", { count: 3 })).toBe(
      "Импортировать 3 проекта",
    );
    expect(translate("ru", "wizard.import.importButton", { count: 5 })).toBe(
      "Импортировать 5 проектов",
    );
    expect(translate("ru", "wizard.import.importButton", { count: 21 })).toBe(
      "Импортировать 21 проект",
    );
    expect(translate("es", "wizard.import.importButton", { count: 2 })).toBe(
      "Importar 2 proyectos",
    );
    expect(translate("zh-CN", "wizard.import.importButton", { count: 2 })).toBe("导入 2 个项目");
    expect(translate("ja", "wizard.import.importButton", { count: 2 })).toBe(
      "2 件のプロジェクトをインポート",
    );
    expect(translate("de", "wizard.import.importButton", { count: 1 })).toBe(
      "1 Projekt importieren",
    );
    // French and Brazilian Portuguese use the singular for zero.
    expect(translate("fr", "wizard.import.importButton", { count: 0 })).toBe("Importer 0 projet");
    expect(translate("pt-BR", "wizard.import.importButton", { count: 0 })).toBe(
      "Importar 0 projeto",
    );
  });

  it("keeps an English duration that other screens already show", () => {
    expect(translate("en", "limit.duration.days", { count: 3 })).toBe("3 days");
    expect(translate("ru", "limit.duration.days", { count: 2 })).toBe("2 дня");
  });
});

describe.each(Object.entries(CATALOGS))("%s catalog", (locale, catalog) => {
  const keys = Object.keys(en) as MessageKey[];

  it("translates every key using only English's values", () => {
    for (const key of keys) {
      const source = en[key];
      const target = catalog[key];
      expect(target, key).toBeDefined();
      expect(typeof target, key).toBe(typeof source);
      // A translation may leave a value out where its grammar reads better without it.
      const allowed = placeholders(source);
      for (const name of placeholders(target))
        expect(allowed.has(name), `${key} {${name}}`).toBe(true);
    }
    expect(Object.keys(catalog).sort()).toEqual([...keys].sort());
  });

  it("covers the language's plural categories", () => {
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    for (const key of keys) {
      const target = catalog[key];
      if (typeof target === "string") continue;
      for (const category of categories) {
        if (category === "other") continue;
        // Romance "many" is for exact millions, which these counts never reach.
        if (category === "many" && ["es", "fr", "pt-BR"].includes(locale)) continue;
        expect(target[category], `${key} ${category}`).toBeDefined();
      }
    }
  });
});

describe("phrases", () => {
  const reference = Object.keys(PHRASE_CATALOGS.ru).sort();

  it("translates a known phrase and leaves an unknown one in English", () => {
    expect(translatePhrase("de", "Settings")).toBe("Einstellungen");
    expect(translatePhrase("ja", "Language")).toBe("言語");
    expect(translatePhrase("en", "Settings")).toBe("Settings");
    expect(translatePhrase("fr", "No such phrase")).toBe("No such phrase");
    expect(translatePhrase("fr", "constructor")).toBe("constructor");
  });

  it("only holds phrases the interface still shows", () => {
    // A copy edit that renames a phrase must move its translations too.
    // Reads the files directly and looks phrases up by quote position. A raw glob
    // import plus a full-text search per phrase took this test past its timeout
    // under release load (1.0.196).
    const sources = NodeFS.readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
      .filter(
        (file) =>
          /\.tsx?$/.test(file) &&
          !NodePath.basename(file).includes(".test.") &&
          !file.startsWith(`i18n${NodePath.sep}`),
      )
      .map((file) => NodeFS.readFileSync(NodePath.join(SRC_DIR, file), "utf8"))
      .join("\n");
    // Every needle starts with a quote, so it can only occur where a quote does:
    // index quote positions by their first PREFIX characters and check those.
    const PREFIX = 3;
    const atQuote = new Map<string, number[]>();
    for (let at = 0; at < sources.length; at++) {
      const char = sources[at];
      if (char !== '"' && char !== "'") continue;
      const key = sources.slice(at, at + PREFIX);
      const positions = atQuote.get(key);
      if (positions) positions.push(at);
      else atQuote.set(key, [at]);
    }
    const occurs = (needle: string) =>
      needle.length < PREFIX
        ? sources.includes(needle)
        : (atQuote.get(needle.slice(0, PREFIX)) ?? []).some((at) => sources.startsWith(needle, at));
    const stale = reference.filter(
      (phrase) => !occurs(JSON.stringify(phrase)) && !occurs(`'${phrase}'`),
    );
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(PHRASE_CATALOGS))(
    "%s covers the same phrases with non-empty text",
    (_locale, catalog) => {
      expect(Object.keys(catalog).sort()).toEqual(reference);
      for (const [english, text] of Object.entries(catalog))
        expect(text.trim().length, english).toBeGreaterThan(0);
    },
  );
});

describe("language preference", () => {
  it("applies a chosen language to translations and the document", async () => {
    const { getLocale, setLocalePreference, t } = await import(".");
    setLocalePreference("ru");
    expect(getLocale()).toBe("ru");
    expect(document.documentElement.lang).toBe("ru");
    expect(t("wizard.title")).toBe("Настройка SpecWithCode");
    setLocalePreference("system");
    expect(t("wizard.title")).toBe(translate(getLocale(), "wizard.title"));
  });
});

// Driver copy is looked up by its exact English text, so an edit there would
// silently fall back to English in every language.
const DRIVER_PHRASES = DRIVER_OPTIONS.flatMap((option) => [
  ...(option.setupDescription === undefined ? [] : [option.setupDescription]),
  ...(option.environmentFields ?? []).flatMap((field) => [
    field.label,
    ...(field.description === undefined ? [] : [field.description]),
    ...(field.placeholder === undefined ? [] : [field.placeholder]),
  ]),
]);

describe.each(Object.entries(PHRASE_CATALOGS))("%s provider driver copy", (_locale, catalog) => {
  it.each(DRIVER_PHRASES)("translates %s", (english) => {
    expect(Object.hasOwn(catalog, english)).toBe(true);
  });
});

// The sidebar translates these model labels by their English text.
const SIDEBAR_LABEL_PHRASES = [
  ...DATE_BUCKETS,
  ...Object.values(THREAD_TONE_LABELS),
  ...Object.values(CHAT_OPTION_LABELS).flatMap((labels) => Object.values(labels)),
];

describe.each(Object.entries(PHRASE_CATALOGS))("%s sidebar labels", (_locale, catalog) => {
  it.each(SIDEBAR_LABEL_PHRASES)("translates %s", (english) => {
    expect(Object.hasOwn(catalog, english)).toBe(true);
  });
});
