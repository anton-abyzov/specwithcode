import { describe, expect, it } from "vite-plus/test";

import {
  isAwayAppCommand,
  leadingSlashQuery,
  matchAwaySkillCommands,
  matchComposerAppCommands,
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
    expect(matchComposerAppCommands("")).toHaveLength(7);
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
