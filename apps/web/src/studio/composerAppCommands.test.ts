import { describe, expect, it } from "vite-plus/test";

import {
  leadingSlashQuery,
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
    expect(matchComposerAppCommands("")).toHaveLength(5);
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
