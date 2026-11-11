import { describe, expect, it } from "vite-plus/test";

import {
  CRASH_REPORT_MAX_BYTES,
  buildCrashReport,
  crashReportEndpoint,
  crashReportMachineLabel,
  crashReportsEnabledFromEnv,
  encodeCrashReport,
  parseCrashReport,
  parseSiteEvent,
  sanitizeErrorMessage,
  sanitizeStack,
  siteEventPlatformForAsset,
} from "./crashReport.ts";

const base = {
  installId: "3f2b8c1e-9a4d-4e5f-8a7b-1c2d3e4f5a6b",
  machine: crashReportMachineLabel("darwin", "arm64", "abcdef0123456789"),
  surface: "desktop" as const,
  kind: "uncaught_exception" as const,
  appVersion: "1.0.230",
  os: "darwin",
  arch: "arm64",
};

describe("crash report sanitizing", () => {
  it("strips home paths, secrets, emails and ids from messages", () => {
    const message = sanitizeErrorMessage(
      "ENOENT: open '/Users/anton/secret-project/notes.md' token=abc123456789 for anton@example.com in 3f2b8c1e-9a4d-4e5f-8a7b-1c2d3e4f5a6b Bearer sk-abcdefghijklmnop",
      "/Users/anton",
    );
    expect(message).not.toContain("anton");
    expect(message).not.toContain("secret-project");
    expect(message).not.toContain("abc123456789");
    expect(message).not.toContain("sk-abcdef");
    expect(message).toContain("ENOENT");
    expect(message).toContain("<path>");
  });

  it("keeps stack frames but shows home as ~", () => {
    const stack = sanitizeStack(
      "Error: boom at /Users/anton/x.ts\n    at run (/Users/anton/Projects/app/src/main.ts:10:5)\n    at C:\\Users\\Anton\\app\\x.js:1:1",
    );
    expect(stack).toContain("at run (main.ts:10:5)");
    expect(stack).toContain("at x.js:1:1");
    expect(stack).not.toMatch(/Users[\\/]+anton/iu);
  });

  it("builds a bounded report and drops bad tokens", () => {
    const report = buildCrashReport({
      ...base,
      category: "provider_error",
      provider: "claude code",
      model: "claude-opus",
      error: new TypeError("bad /home/me/file.txt"),
      detail: { reason: "crashed", exitCode: 9, "bad key": "x" },
    });
    expect(report.provider).toBeUndefined();
    expect(report.model).toBe("claude-opus");
    expect(report.errorName).toBe("TypeError");
    expect(report.message).toBe("bad <path>");
    expect(report.detail).toEqual({ reason: "crashed", exitCode: 9 });
  });

  it("encodes under the byte cap", () => {
    const report = buildCrashReport({
      ...base,
      error: { message: "x".repeat(5000), stack: "at x\n".repeat(5000) },
    });
    expect(new TextEncoder().encode(encodeCrashReport(report)).length).toBeLessThanOrEqual(
      CRASH_REPORT_MAX_BYTES,
    );
  });

  it("parses only valid bodies", () => {
    const report = buildCrashReport({ ...base, error: new Error("x") });
    expect(parseCrashReport(JSON.parse(encodeCrashReport(report)))?.kind).toBe(
      "uncaught_exception",
    );
    expect(parseCrashReport({ ...report, installId: "acct_123" })).toBeNull();
    expect(parseCrashReport({ ...report, surface: "toaster" })).toBeNull();
    expect(parseCrashReport({ ...report, message: "from /Users/bob/a/b" })?.message).toBe(
      "from <path>",
    );
  });

  it("reads the env switch and endpoint override", () => {
    expect(crashReportsEnabledFromEnv(undefined)).toBe(true);
    expect(crashReportsEnabledFromEnv("false")).toBe(false);
    expect(crashReportsEnabledFromEnv("0")).toBe(false);
    expect(crashReportsEnabledFromEnv("true")).toBe(true);
    expect(crashReportEndpoint(undefined)).toBe("https://relay.spec-weave.com/v1/crash-reports");
    expect(crashReportEndpoint("http://evil.example")).toBe(
      "https://relay.spec-weave.com/v1/crash-reports",
    );
    expect(crashReportEndpoint("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787/v1/crash-reports",
    );
  });
});

describe("review hardening", () => {
  it("redacts secrets in JSON nested inside a JSON string", () => {
    const text = sanitizeErrorMessage(
      '{"error":"{\\"token\\":\\"abc123def456\\",\\"refresh_token\\":\\"short-secret\\"}"}',
    );
    expect(text).not.toContain("abc123def456");
    expect(text).not.toContain("short-secret");
  });

  it("sanitizes every non-frame stack line and trims frame paths", () => {
    const stack = sanitizeStack(
      'Error: boom\n  detail: prompt was "summarize /Volumes/X/secret.txt please"\n    at foo (file:///Volumes/Client/app/x.js:1:2)\n    at bar (/opt/app/node_modules/effect/dist/esm/Effect.js:3:4)\n    at baz (/Applications/SpecWithCode.app/Contents/Resources/app.asar/dist-electron/main.js:9:9)',
    );
    expect(stack).not.toContain("Volumes");
    expect(stack).not.toContain("secret.txt");
    expect(stack).toContain("at foo (x.js:1:2)");
    expect(stack).toContain("at bar (node_modules/effect/dist/esm/Effect.js:3:4)");
    expect(stack).toContain("at baz (dist-electron/main.js:9:9)");
  });

  it("handles spaces in user and folder names, and hostnames", () => {
    const message = sanitizeErrorMessage(
      "open '/Volumes/Client Acme/Q4 plan/notes.md' from /Users/Anton Abyzov/Projects/acme via getaddrinfo ENOTFOUND antons-mbp.local on antons-mbp",
      null,
      ["antons-mbp.local"],
    );
    expect(message).not.toMatch(/Acme|Q4|notes|Abyzov|antons-mbp/u);
  });

  it("keeps only a safe model name and drops turn failure text", () => {
    const report = buildCrashReport({
      ...base,
      kind: "turn_failed",
      model: "/Users/anton/models/acme-private.gguf",
      error: {
        name: "invalid_request",
        message: 'messages[0].content "rewrite my letter"',
        stack: "x",
      },
      homeDir: "/Users/anton",
    });
    expect(report.model).toBe("acme-private.gguf");
    expect(report.message).toBeUndefined();
    expect(report.stack).toBeUndefined();
    expect(report.errorName).toBe("invalid_request");
    expect(buildCrashReport({ ...base, model: "anton@host/finetune" }).model).toBe("host/finetune");
  });
});

describe("site events", () => {
  it("validates download clicks", () => {
    expect(
      parseSiteEvent({
        v: 1,
        event: "download_click",
        platform: "mac",
        asset: "arm64.dmg",
        page: "/download",
      }),
    ).toEqual({
      v: 1,
      event: "download_click",
      platform: "mac",
      asset: "arm64.dmg",
      page: "/download",
    });
    expect(parseSiteEvent({ v: 1, event: "download_click", platform: "beos" })?.platform).toBe(
      "other",
    );
    expect(parseSiteEvent({ v: 1, event: "page_view", platform: "mac" })).toBeNull();
    expect(siteEventPlatformForAsset("SpecWithCode-1.0.1-x64.exe")).toBe("windows");
    expect(siteEventPlatformForAsset("x86_64.AppImage")).toBe("linux-appimage");
  });
});
