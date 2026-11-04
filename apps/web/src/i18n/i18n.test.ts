// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { matchLocale, resolveLocale, resolveSystemLocale, SUPPORTED_LOCALES, translate } from ".";
import { en, type MessageKey } from "./messages/en";
import { es } from "./messages/es";
import { ru } from "./messages/ru";
import { zh } from "./messages/zh";

const CATALOGS = { ru, es, "zh-CN": zh } as const;

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
    expect(matchLocale("de-DE")).toBeNull();
  });

  it("takes the first supported browser language and falls back to English", () => {
    expect(resolveSystemLocale(["de-DE", "ru", "en"])).toBe("ru");
    expect(resolveSystemLocale(["fr-FR"])).toBe("en");
    expect(resolveSystemLocale(undefined)).toBe("en");
    expect(resolveLocale("es", ["ru"])).toBe("es");
    expect(resolveLocale("system", ["ru"])).toBe("ru");
  });

  it("lists every catalog", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "ru", "es", "zh-CN"]);
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
  });

  it("keeps an English duration that other screens already show", () => {
    expect(translate("en", "limit.duration.days", { count: 3 })).toBe("3 days");
    expect(translate("ru", "limit.duration.days", { count: 2 })).toBe("2 дня");
  });
});

describe("catalogs", () => {
  const keys = Object.keys(en) as MessageKey[];

  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    it(`${locale} translates every key using only English's values`, () => {
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

    it(`${locale} plural messages cover the language's categories`, () => {
      const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      for (const key of keys) {
        const target = catalog[key];
        if (typeof target === "string") continue;
        for (const category of categories) {
          if (category === "other") continue;
          // Spanish "many" is for exact millions, which these counts never reach.
          if (locale === "es" && category === "many") continue;
          expect(target[category], `${key} ${category}`).toBeDefined();
        }
      }
    });
  }
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
