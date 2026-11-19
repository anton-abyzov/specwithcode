// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { de } from "./phrases/de";
import { es } from "./phrases/es";
import { fr } from "./phrases/fr";
import { ja } from "./phrases/ja";
import { ko } from "./phrases/ko";
import { pt } from "./phrases/pt";
import { ru } from "./phrases/ru";
import { zh } from "./phrases/zh";
import { BANNED, RETIRED_PHRASES, RETIRED_TEXT } from "./retiredPhrases";

const PHRASE_CATALOGS = { de, es, fr, ja, ko, pt, ru, zh };

const SRC_DIR = NodePath.resolve(import.meta.dirname, "..");
const sources = NodeFS.readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
  .filter(
    (file) =>
      /\.tsx?$/u.test(file) &&
      !NodePath.basename(file).includes(".test.") &&
      !file.startsWith(`i18n${NodePath.sep}`),
  )
  .map((file) => NodeFS.readFileSync(NodePath.join(SRC_DIR, file), "utf8"))
  .join("\n");

describe("retired interface phrases", () => {
  it("keeps every retired phrase out of the interface", () => {
    const back = RETIRED_PHRASES.filter(
      (phrase) => sources.includes(JSON.stringify(phrase)) || sources.includes(`'${phrase}'`),
    );
    expect(back).toEqual([]);
    expect(RETIRED_TEXT.filter((text) => sources.includes(text))).toEqual([]);
  });

  it("keeps every retired phrase out of the catalogs", () => {
    for (const [language, catalog] of Object.entries(PHRASE_CATALOGS))
      expect(
        RETIRED_PHRASES.filter((phrase) => Object.hasOwn(catalog, phrase)),
        language,
      ).toEqual([]);
  });

  it("has no phrase that calls a machine Main or a Copy of it", () => {
    const [catalog] = Object.values(PHRASE_CATALOGS);
    const role = Object.keys(catalog ?? {}).filter((phrase) =>
      BANNED.some((pattern) => pattern.test(phrase)),
    );
    expect(role).toEqual([]);
  });
});
