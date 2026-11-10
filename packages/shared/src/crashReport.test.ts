import { describe, expect, it } from "vitest";

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
    expect(stack).toContain("at run (~/Projects/app/src/main.ts:10:5)");
    expect(stack).toContain("at ~\\app\\x.js:1:1");
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
    expect(parseSiteEvent({ v: 1, event: "download_click", platform: "beos" })).toBeNull();
    expect(siteEventPlatformForAsset("SpecWithCode-1.0.1-x64.exe")).toBe("windows");
    expect(siteEventPlatformForAsset("x86_64.AppImage")).toBe("linux-appimage");
  });
});
