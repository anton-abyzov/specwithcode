import { describe, expect, it } from "vite-plus/test";

import {
  availabilityFrom,
  compareVersions,
  detectCloudCliPrompt,
  detectCloudCreateFailure,
  parseClaudeAuthStatus,
  parseClaudeVersion,
  parseCloudSendOutput,
  parseCloudSessionCreated,
  stripTerminalOutput,
} from "./cliOutput.ts";

// Captured from Claude Code 2.1.301 on October 16, 2026: the trust question,
// then the three lines it prints once the cloud VM exists. Words on screen are
// separated by cursor-forward sequences, not spaces.
const TRUST_SCREEN =
  "\u001b[2J\u001b[1;1HAccessing\u001b[1Cworkspace:\r\n" +
  "/Users/me/project\r\n" +
  "Quick\u001b[1Csafety\u001b[1Ccheck:\u001b[1CIs\u001b[1Cthis\u001b[1Ca\u001b[1Cproject\u001b[1Cyou\u001b[1Ccreated\u001b[1Cor\u001b[1Cone\u001b[1Cyou\u001b[1Ctrust?\r\n" +
  "❯\u001b[1CNo,\u001b[1Cexit\r\n" +
  "\u001b[2CYes,\u001b[1CI\u001b[1Ctrust\u001b[1Cthis\u001b[1Cfolder\r\n";
const CREATED_SCREEN =
  "\u001b[>4m\u001b[<uCreated cloud session: Single-word OK reply\r\n" +
  "View: https://claude.ai/code/session_01Kw5qcBaa27jRK3Hjn4zsC2?from=cli&m=0\r\n" +
  "Resume with: claude --teleport session_01Kw5qcBaa27jRK3Hjn4zsC2\r\n";

describe("stripTerminalOutput", () => {
  it("turns cursor-forward into spaces and drops the rest", () => {
    const plain = stripTerminalOutput(TRUST_SCREEN);
    expect(plain).toContain("Accessing workspace:");
    expect(plain).toContain("Yes, I trust this folder");
    expect(plain).not.toContain("\u001b");
  });
});

describe("detectCloudCliPrompt", () => {
  it("sees the folder trust question even with the spaces lost", () => {
    expect(detectCloudCliPrompt("Quicksafetycheck:Isthisaprojectyoucreated")).toBe("trust_folder");
    expect(detectCloudCliPrompt(stripTerminalOutput(TRUST_SCREEN))).toBe("trust_folder");
    expect(detectCloudCliPrompt("Cloning repository")).toBeNull();
  });
});

describe("parseCloudSessionCreated", () => {
  it("reads the id, URL and title the CLI prints", () => {
    const created = parseCloudSessionCreated(stripTerminalOutput(CREATED_SCREEN));
    expect(created).toEqual({
      sessionId: "session_01Kw5qcBaa27jRK3Hjn4zsC2",
      url: "https://claude.ai/code/session_01Kw5qcBaa27jRK3Hjn4zsC2?from=cli&m=0",
      title: "Single-word OK reply",
    });
  });
  it("falls back to the teleport line or a Session ID line", () => {
    expect(parseCloudSessionCreated("Resume with: claude --teleport cse_abc123")).toEqual({
      sessionId: "cse_abc123",
      url: "https://claude.ai/code/cse_abc123",
      title: null,
    });
    expect(parseCloudSessionCreated("Session ID: session_xyz")?.sessionId).toBe("session_xyz");
  });
  it("is null while the CLI is still provisioning", () => {
    expect(parseCloudSessionCreated("Cloning repository…\nRunning setup script")).toBeNull();
  });
});

describe("detectCloudCreateFailure", () => {
  it("names the sign-in and policy failures", () => {
    expect(detectCloudCreateFailure("Error: Unable to get organization UUID")).toMatch(
      /claude auth login/,
    );
    expect(
      detectCloudCreateFailure("Cloud sessions are disabled by your organization's policy."),
    ).toMatch(/admin-settings/);
    expect(detectCloudCreateFailure("Not uploading this working tree: older git")).toMatch(
      /refused to upload/,
    );
    expect(detectCloudCreateFailure("Cloning repository")).toBeNull();
  });
});

describe("parseCloudSendOutput", () => {
  it("reads the JSON result", () => {
    expect(
      parseCloudSendOutput(
        '{"ok":true,"session_id":"session_1","url":"https://claude.ai/code/session_1"}\n',
        "",
        0,
      ),
    ).toEqual({
      ok: true,
      sessionId: "session_1",
      url: "https://claude.ai/code/session_1",
      error: null,
    });
    expect(
      parseCloudSendOutput(
        '{"ok":false,"session_id":"session_1","error":"Session not found"}',
        "",
        1,
      ),
    ).toMatchObject({ ok: false, error: "Session not found" });
  });
  it("keeps the CLI's own words when there is no JSON", () => {
    const result = parseCloudSendOutput(
      "",
      "Error: Cloud sessions are disabled by your organization's policy.",
      1,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disabled by your organization");
  });
});

describe("availabilityFrom", () => {
  const checkedAt = "2026-10-16T23:00:00.000Z";
  const auth = (
    authMethod: string | null,
    loggedIn = true,
    subscriptionType: string | null = "max",
  ) => ({ loggedIn, authMethod, subscriptionType }) as const;
  it("is ready for a claude.ai sign-in on a current CLI", () => {
    const availability = availabilityFrom({
      cliFound: true,
      cliVersion: "2.1.301",
      auth: auth("claude.ai"),
      checkedAt,
    });
    expect(availability.status).toBe("ready");
    expect(availability.reason).toContain("max");
    expect(availability.fix).toBeNull();
  });
  it("explains each way it is unavailable", () => {
    expect(
      availabilityFrom({ cliFound: false, cliVersion: null, auth: null, checkedAt }).status,
    ).toBe("cli_missing");
    expect(
      availabilityFrom({
        cliFound: true,
        cliVersion: "2.1.100",
        auth: auth("claude.ai"),
        checkedAt,
      }).status,
    ).toBe("cli_too_old");
    expect(
      availabilityFrom({
        cliFound: true,
        cliVersion: "2.1.301",
        auth: auth("none", false),
        checkedAt,
      }).status,
    ).toBe("needs_login");
    const apiKey = availabilityFrom({
      cliFound: true,
      cliVersion: "2.1.301",
      auth: auth("api_key", true, null),
      checkedAt,
    });
    expect(apiKey.status).toBe("unsupported_auth");
    expect(apiKey.reason).toContain("API key");
    expect(
      availabilityFrom({ cliFound: true, cliVersion: "2.1.301", auth: null, checkedAt }).status,
    ).toBe("unknown");
  });
});

describe("version and auth status parsing", () => {
  it("reads versions and compares them", () => {
    expect(parseClaudeVersion("2.1.301 (Claude Code)")).toBe("2.1.301");
    expect(compareVersions("2.1.301", "2.1.223")).toBeGreaterThan(0);
    expect(compareVersions("2.1.9", "2.1.10")).toBeLessThan(0);
    expect(compareVersions("2.1.0", "2.1")).toBe(0);
  });
  it("reads only the auth fields it needs", () => {
    expect(
      parseClaudeAuthStatus(
        '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b.c","subscriptionType":"max"}',
      ),
    ).toEqual({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
    expect(parseClaudeAuthStatus("not json")).toBeNull();
  });
});
