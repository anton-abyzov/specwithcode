import { describe, expect, it } from "vite-plus/test";

import { de } from "../i18n/phrases/de";
import { es } from "../i18n/phrases/es";
import { fr } from "../i18n/phrases/fr";
import { ja } from "../i18n/phrases/ja";
import { ko } from "../i18n/phrases/ko";
import { pt } from "../i18n/phrases/pt";
import { ru } from "../i18n/phrases/ru";
import { zh } from "../i18n/phrases/zh";
import {
  COMPOSER_APP_COMMANDS,
  composerAppCommandDescription,
  isAwayAppCommand,
  leadingSlashQuery,
  matchAwaySkillCommands,
  matchComposerAppCommands,
  parseAwayAppCommand,
  parseComposerAppCommand,
} from "./composerAppCommands";

describe("parseComposerAppCommand", () => {
  it("reads a whole-message app command", () => {
    expect(parseComposerAppCommand(" /stop ")).toBe("stop");
    expect(parseComposerAppCommand("/Stop-All")).toBe("stop-all");
    expect(parseComposerAppCommand("/continue-all\n")).toBe("continue-all");
    expect(parseComposerAppCommand("/status")).toBe("status");
  });

  it("leaves everything else for the agent", () => {
    expect(parseComposerAppCommand("/stop the build")).toBeNull();
    expect(parseComposerAppCommand("/review")).toBeNull();
    expect(parseComposerAppCommand("please /stop")).toBeNull();
    expect(parseComposerAppCommand("/stopall")).toBeNull();
  });

  it("reads /away and /back, and their $ forms, as the whole message", () => {
    expect(parseComposerAppCommand("/away")).toBe("away");
    expect(parseComposerAppCommand(" /AWAY ")).toBe("away");
    expect(parseComposerAppCommand("/back\n")).toBe("back");
    expect(parseComposerAppCommand("$away")).toBe("away");
    expect(parseComposerAppCommand(" $Back ")).toBe("back");
    expect(isAwayAppCommand("away")).toBe(true);
    expect(isAwayAppCommand("status")).toBe(false);
  });

  it("leaves longer away messages and other $ skills for the agent", () => {
    expect(parseComposerAppCommand("/away now")).toBeNull();
    expect(parseComposerAppCommand("$away now")).toBeNull();
    expect(parseComposerAppCommand("I am /away")).toBeNull();
    expect(parseComposerAppCommand("$stop")).toBeNull();
    expect(parseComposerAppCommand("$review")).toBeNull();
    expect(parseComposerAppCommand("$awayday")).toBeNull();
  });
});

describe("matchComposerAppCommands", () => {
  it("lists prefix matches first", () => {
    expect(matchComposerAppCommands("stop").map((entry) => entry.command)).toEqual([
      "stop",
      "stop-all",
      "continue",
    ]);
    expect(matchComposerAppCommands("all").map((entry) => entry.command)).toEqual([
      "stop-all",
      "continue-all",
    ]);
    expect(matchComposerAppCommands("")).toHaveLength(8);
    expect(matchComposerAppCommands("handoff").map((entry) => entry.command)).toEqual(["handoff"]);
    expect(parseComposerAppCommand("/handoff")).toBe("handoff");
    // `$handoff` stays a skill name: only the slash form is the app's.
    expect(parseComposerAppCommand("$handoff")).toBeNull();
    expect(isAwayAppCommand("handoff")).toBe(false);
    expect(matchComposerAppCommands("aw").map((entry) => entry.command)).toEqual(["away"]);
    expect(matchComposerAppCommands("back").map((entry) => entry.command)).toEqual(["back"]);
  });
});

describe("matchAwaySkillCommands", () => {
  it("offers $away and $back in the skill menu by prefix", () => {
    expect(matchAwaySkillCommands("").map((entry) => entry.command)).toEqual(["away", "back"]);
    expect(matchAwaySkillCommands("AW").map((entry) => entry.command)).toEqual(["away"]);
    expect(matchAwaySkillCommands("b").map((entry) => entry.command)).toEqual(["back"]);
    expect(matchAwaySkillCommands("review")).toEqual([]);
  });
});

describe("leadingSlashQuery", () => {
  it("opens only for a slash word that is the whole draft", () => {
    expect(leadingSlashQuery("/", 1)).toBe("");
    expect(leadingSlashQuery("/sto", 4)).toBe("sto");
    expect(leadingSlashQuery("/skill:review", 13)).toBe("skill:review");
    expect(leadingSlashQuery("hi /sto", 7)).toBeNull();
    expect(leadingSlashQuery("/stop now", 9)).toBeNull();
    expect(leadingSlashQuery("/stop now", 5)).toBeNull();
  });
});

describe("parseAwayAppCommand", () => {
  it("reads only the Away commands, slash or dollar form", () => {
    expect(parseAwayAppCommand("/away")).toBe("away");
    expect(parseAwayAppCommand(" $Back ")).toBe("back");
    expect(parseAwayAppCommand("/stop")).toBeNull();
    expect(parseAwayAppCommand("/away now")).toBeNull();
    expect(parseAwayAppCommand("hello")).toBeNull();
  });
});

describe("the /handoff description", () => {
  const entry = COMPOSER_APP_COMMANDS.find((item) => item.command === "handoff")!;

  it("is in every catalog", () => {
    for (const [language, catalog] of Object.entries({ de, es, fr, ja, ko, pt, ru, zh }))
      expect(Object.hasOwn(catalog, entry.description), language).toBe(true);
  });

  it("is shown in the interface language", () => {
    const german = (english: string) => (de as Record<string, string>)[english] ?? english;
    const shown = composerAppCommandDescription(entry, german);
    expect(shown).toBe((de as Record<string, string>)[entry.description]);
    expect(shown).not.toBe(entry.description);
    // A description with no translation stays English.
    const stop = COMPOSER_APP_COMMANDS.find((item) => item.command === "stop")!;
    expect(composerAppCommandDescription(stop, german)).toBe(stop.description);
  });
});
