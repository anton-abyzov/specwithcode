import { describe, expect, it } from "vite-plus/test";

import {
  buildClaudeShipTerminalCommand,
  claudeShipPermissionMode,
  claudeShipPlan,
  ClaudeShipCommandError,
  isClaudeVersionAtLeast,
  parseClaudeShipCommand,
} from "./claudeShip.logic";

describe("parseClaudeShipCommand", () => {
  it("takes /ship and /steward with their documented arguments", () => {
    expect(parseClaudeShipCommand("/ship")).toEqual({ command: "ship", line: "/ship" });
    expect(parseClaudeShipCommand("  /SHIP  low 41   +my-lint-bot ")).toEqual({
      command: "ship",
      line: "/ship low 41 +my-lint-bot",
    });
    expect(parseClaudeShipCommand("/steward https://github.com/o/r/pull/12")).toEqual({
      command: "steward",
      line: "/steward https://github.com/o/r/pull/12",
    });
    expect(parseClaudeShipCommand("/ship stop")?.line).toBe("/ship stop");
    expect(parseClaudeShipCommand("/steward terms")?.line).toBe("/steward terms");
    expect(parseClaudeShipCommand("/steward +bot-a +bot-b")?.line).toBe("/steward +bot-a +bot-b");
  });

  it("leaves other drafts alone", () => {
    for (const text of [
      "/shipit",
      "ship it",
      "/ship this change please",
      "/ship 41 42",
      "/ship 41 high",
      "/steward high",
      "/ship stop now",
      "please /ship",
      "",
    ]) {
      expect(parseClaudeShipCommand(text)).toBeNull();
    }
  });
});

describe("claudeShipPermissionMode", () => {
  it("never opens a watch under bypass permissions", () => {
    expect(claudeShipPermissionMode("approval-required")).toBe("default");
    expect(claudeShipPermissionMode("auto-accept-edits")).toBe("acceptEdits");
    expect(claudeShipPermissionMode("auto")).toBe("auto");
    expect(claudeShipPermissionMode("full-access")).toBe("auto");
  });
});

describe("isClaudeVersionAtLeast", () => {
  it("compares dotted versions and reads CLI version strings", () => {
    expect(isClaudeVersionAtLeast("2.1.331 (Claude Code)", "2.1.330")).toBe(true);
    expect(isClaudeVersionAtLeast("2.1.330", "2.1.330")).toBe(true);
    expect(isClaudeVersionAtLeast("2.1.302", "2.1.330")).toBe(false);
    expect(isClaudeVersionAtLeast("3.0", "2.1.330")).toBe(true);
    expect(isClaudeVersionAtLeast(null, "2.1.330")).toBeNull();
    expect(isClaudeVersionAtLeast("unknown", "2.1.330")).toBeNull();
  });
});

describe("claudeShipPlan", () => {
  const base = {
    cliVersion: "2.1.331",
    interactionMode: "default",
    runtimeMode: "auto" as const,
    platform: "darwin",
    sessionId: "0f6c8a5e-1111-4222-8333-444455556666",
  };

  it("opens with no notes on a current CLI and a Claude session", () => {
    expect(claudeShipPlan(base)).toEqual({ notes: [], canOpen: true });
  });

  it("blocks an outdated CLI and notes plan mode, full access and a new session", () => {
    expect(
      claudeShipPlan({
        ...base,
        cliVersion: "2.1.302",
        interactionMode: "plan",
        runtimeMode: "full-access",
        sessionId: null,
      }),
    ).toEqual({
      notes: [
        { kind: "outdated", version: "2.1.302" },
        { kind: "plan" },
        { kind: "full-access" },
        { kind: "new-session" },
      ],
      canOpen: false,
    });
  });

  it("lets an unknown version through and stops on Windows", () => {
    expect(claudeShipPlan({ ...base, cliVersion: null }).canOpen).toBe(true);
    expect(claudeShipPlan({ ...base, platform: "windows" })).toEqual({
      notes: [{ kind: "windows" }],
      canOpen: false,
    });
  });
});

describe("buildClaudeShipTerminalCommand", () => {
  it("forks the thread's session in an explicit mode with the session markers cleared", () => {
    const command = buildClaudeShipTerminalCommand({
      binaryPath: "claude",
      sessionId: "0f6c8a5e-1111-4222-8333-444455556666",
      permissionMode: "auto",
    });
    expect(command).toMatch(/^env (-u [A-Z_]+ )+-- 'claude' --permission-mode 'auto'/);
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"]) {
      expect(command).toContain(`-u ${name} `);
    }
    expect(command.endsWith("--resume '0f6c8a5e-1111-4222-8333-444455556666' --fork-session")).toBe(
      true,
    );
    expect(command).not.toContain("/ship");
  });

  it("starts a new session when the thread has none and expands a home path", () => {
    expect(
      buildClaudeShipTerminalCommand({
        binaryPath: "~/.local/bin/claude",
        sessionId: null,
        permissionMode: "default",
      }),
    ).toMatch(/ "\$HOME"\/'\.local\/bin\/claude' --permission-mode 'default'$/);
    expect(
      buildClaudeShipTerminalCommand({ binaryPath: "  ", sessionId: null, permissionMode: "auto" }),
    ).toContain(" 'claude' ");
  });

  it("refuses values the shell could read as code", () => {
    for (const binaryPath of ["claude; rm -rf ~", "$(evil)", "a'b", "claude\nx", "`x`", "-S rm"]) {
      expect(() =>
        buildClaudeShipTerminalCommand({ binaryPath, sessionId: null, permissionMode: "auto" }),
      ).toThrow(ClaudeShipCommandError);
    }
    expect(() =>
      buildClaudeShipTerminalCommand({
        binaryPath: "claude",
        sessionId: "x' --dangerously-skip-permissions '",
        permissionMode: "auto",
      }),
    ).toThrow(ClaudeShipCommandError);
  });
});
