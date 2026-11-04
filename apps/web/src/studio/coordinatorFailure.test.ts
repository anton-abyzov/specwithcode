import { describe, expect, it } from "vite-plus/test";

import {
  coordinatorFailureResetAt,
  coordinatorFailureText,
  coordinatorFixAction,
  formatResetWhen,
  nameMachineInText,
  retryRoutingNotice,
} from "./coordinatorFailure";

const HOST_LIMIT =
  "This native subscription profile has no remaining permitted usage under its current usage limit. Next observed reset: 2026-11-06T02:00:00.000Z. Select an eligible profile for a new session.";
const NOW = Date.parse("2026-11-04T17:00:00.000Z");
const DATES = {
  locale: "en-US",
  timeZone: "America/New_York",
  timestampFormat: "12-hour",
} as const;

describe("when a coordinator limit resets", () => {
  it("reads the structured reset time first", () => {
    expect(
      coordinatorFailureResetAt({ resetAt: "2026-11-07T00:00:00.000Z", message: HOST_LIMIT }),
    ).toBe("2026-11-07T00:00:00.000Z");
  });

  it("falls back to the time in the host's text, and to nothing for a bad one", () => {
    expect(coordinatorFailureResetAt({ resetAt: null, message: HOST_LIMIT })).toBe(
      "2026-11-06T02:00:00.000Z",
    );
    expect(
      coordinatorFailureResetAt({ resetAt: null, message: "Next observed reset: soon. Retry." }),
    ).toBeNull();
    expect(coordinatorFailureResetAt({ resetAt: "not a date", message: "Failed." })).toBeNull();
  });

  it("says the local weekday and time, then how long until then", () => {
    expect(formatResetWhen("2026-11-06T02:00:00.000Z", NOW, DATES)).toBe(
      "resets Thu 9:00 PM, in 1d 9h",
    );
    expect(
      formatResetWhen("2026-11-06T02:00:00.000Z", NOW, { ...DATES, timestampFormat: "24-hour" }),
    ).toBe("resets Thu 21:00, in 1d 9h");
  });

  it("never says 'in 0m', and says 'reset' once the time has passed", () => {
    expect(formatResetWhen(new Date(NOW + 10_000).toISOString(), NOW, DATES)).toMatch(/in 1m$/);
    expect(formatResetWhen("2026-11-04T16:00:00.000Z", NOW, DATES)).toBe("reset Wed 11:00 AM");
    expect(formatResetWhen(null, NOW, DATES)).toBeNull();
  });
});

describe("the coordinator failure card's text", () => {
  it("names the machine, the profile and the reset in one sentence, from structured fields", () => {
    const text = coordinatorFailureText({
      failure: {
        runId: "run:thread:project-coordinator%3A58004cd4:ordinal:23",
        message: HOST_LIMIT,
        errorClass: "usage_limit",
        resetAt: "2026-11-06T02:00:00.000Z",
      },
      machineLabel: "M1",
      profileLabel: "Claude Code · Opus 5.5",
      nowMs: NOW,
      dates: DATES,
    });
    expect(text.usageLimit).toBe(true);
    expect(text.body).toBe(
      "Claude Code · Opus 5.5 on M1 has no usage left. It resets Thu 9:00 PM, in 1d 9h. Retry checks again, or pick another model.",
    );
    expect(text.body).not.toContain("ordinal");
    // The host's own words stay for the details, once.
    expect(text.detail).toBe(HOST_LIMIT);
  });

  it("parses the host's reset when an older host sent no structured time", () => {
    const text = coordinatorFailureText({
      failure: { runId: "run-1", message: HOST_LIMIT, errorClass: "usage_limit", resetAt: null },
      machineLabel: "M1",
      profileLabel: null,
      nowMs: NOW,
      dates: DATES,
    });
    expect(text.body).toBe(
      "This model on M1 has no usage left. It resets Thu 9:00 PM, in 1d 9h. Retry checks again, or pick another model.",
    );
  });

  it("says Retry should work once the reset time has passed", () => {
    const text = coordinatorFailureText({
      failure: {
        runId: "run-1",
        message: HOST_LIMIT,
        errorClass: "usage_limit",
        resetAt: "2026-11-04T16:00:00.000Z",
      },
      machineLabel: "M1",
      profileLabel: "Claude Code · Opus 5.5",
      nowMs: NOW,
      dates: DATES,
    });
    expect(text.usageLimit).toBe(true);
    expect(text.body).toBe(
      "Claude Code · Opus 5.5 on M1 hit its usage limit. The limit reset Wed 11:00 AM, so Retry should work.",
    );
    expect(text.body).not.toContain("no usage left");
  });

  it("shows any other failure once, with the machine named, and no second copy", () => {
    const text = coordinatorFailureText({
      failure: {
        runId: "run-1",
        message: "Copilot · Auto cannot run on this machine. Open Settings on that machine.",
        errorClass: "provider_error",
      },
      machineLabel: "M1",
      profileLabel: "Copilot · Auto",
      nowMs: NOW,
    });
    expect(text).toEqual({
      body: "Copilot · Auto cannot run on M1. Open Settings on M1.",
      detail: null,
      usageLimit: false,
    });
  });
});

describe("naming the machine", () => {
  it("replaces 'this machine' and 'that machine' only when a real name is known", () => {
    const text =
      "Copilot · Auto cannot run on this machine: not prepared. Open Settings > Providers > Copilot on that machine.";
    expect(nameMachineInText(text, "M1")).toBe(
      "Copilot · Auto cannot run on M1: not prepared. Open Settings > Providers > Copilot on M1.",
    );
    expect(nameMachineInText(text, null)).toBe(text);
    expect(nameMachineInText(text, "this machine")).toBe(text);
  });
});

describe("the coordinator's provider fix", () => {
  const copilot = {
    displayName: "GitHub Copilot",
    enabled: true,
    installed: false,
    authStatus: "unknown",
    status: "error",
    oneClickInstall: true,
  };

  it("installs an unprepared registry agent on the named machine", () => {
    expect(coordinatorFixAction({ provider: copilot, machineLabel: "M1" })).toEqual({
      kind: "install",
      label: "Install Copilot on M1",
    });
    expect(coordinatorFixAction({ provider: copilot, machineLabel: null })?.label).toBe(
      "Install Copilot",
    );
  });

  it("asks a signed-out provider to sign in, and sends anything else to setup", () => {
    expect(
      coordinatorFixAction({
        provider: {
          ...copilot,
          installed: true,
          status: "ready",
          authStatus: "unauthenticated",
          oneClickInstall: false,
        },
        machineLabel: "M1",
      }),
    ).toEqual({ kind: "sign-in", label: "Sign in to Copilot on M1" });
    expect(
      coordinatorFixAction({
        provider: { ...copilot, oneClickInstall: false },
        machineLabel: "M1",
      }),
    ).toEqual({ kind: "setup", label: "Open provider setup" });
    expect(coordinatorFixAction({ provider: null, machineLabel: "M1" })?.kind).toBe("setup");
  });

  it("offers nothing for a provider that can run", () => {
    expect(
      coordinatorFixAction({
        provider: {
          ...copilot,
          installed: true,
          status: "ready",
          authStatus: "authenticated",
          oneClickInstall: false,
        },
        machineLabel: "M1",
      }),
    ).toBeNull();
  });
});

it("says where a retry went", () => {
  expect(retryRoutingNotice("Claude Code · Opus 5.5")).toBe("Retrying on Claude Code · Opus 5.5.");
});
