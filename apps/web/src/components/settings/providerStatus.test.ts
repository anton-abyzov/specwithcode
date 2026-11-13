import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderStatusView,
  getProviderSummary,
  getProviderVersionAdvisoryPresentation,
  statusRowShowsSetup,
} from "./providerStatus";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getProviderSummary", () => {
  it("reports ready providers with unknown authentication as available", () => {
    expect(getProviderSummary({ ...provider, auth: { status: "unknown" } })).toEqual({
      headline: "Available",
      detail: null,
    });
  });

  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        message: "The provider process failed to start.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("does not hide a provider warning behind an authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Run codex login.",
      }),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("treats a disabled provider status as disabled even before its enabled flag updates", () => {
    expect(getProviderSummary({ ...provider, status: "disabled" }).headline).toBe("Disabled");
  });
});

it("keeps a supported manual-only update separate from native readiness and sign-in", () => {
  const detail =
    "Update the configured executable with its owning installer, then refresh Providers. This installation cannot be updated from Studio.";
  const advisory = {
    status: "behind_latest" as const,
    currentVersion: "0.160.1",
    latestVersion: "0.161.0",
    canUpdate: false,
    canInstallVersion: false,
    updateCommand: null,
    checkedAt: provider.checkedAt,
    message: detail,
  };
  expect(
    getProviderVersionAdvisoryPresentation(advisory, {
      status: "supported",
      latestVersionStatus: "supported",
      message: null,
      recommendedVersion: null,
      recommendedRange: ">=0.159.0",
    }),
  ).toEqual({
    title: "Update available",
    detail,
    updateCommand: null,
    emphasis: "normal",
    targetVersion: null,
  });
  expect(getProviderSummary({ ...provider, versionAdvisory: advisory })).toEqual({
    headline: "Authenticated · ChatGPT",
    detail: null,
  });
});

it("does not suggest copying a command that installs an incompatible latest version", () => {
  const advisory = {
    status: "behind_latest" as const,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "supported" as const,
    latestVersionStatus: "broken" as const,
    message: null,
    recommendedRange: null,
    recommendedVersion: null,
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, { ...compatibility, status: "broken" }, false),
  ).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, {
      ...compatibility,
      latestVersionStatus: "supported",
    }),
  ).not.toBeNull();
});

it("shows compatibility in the version popover even when the installed version is current", () => {
  const advisory = {
    status: "current" as const,
    currentVersion: "2.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "broken" as const,
    latestVersionStatus: "broken" as const,
    message: "This version drops turns. Use 1.9.0.",
    recommendedRange: null,
    recommendedVersion: "1.9.0",
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toEqual({
    title: "Known broken version",
    detail: compatibility.message,
    updateCommand: null,
    emphasis: "strong",
    targetVersion: "1.9.0",
  });
  expect(
    getProviderVersionAdvisoryPresentation(undefined, {
      ...compatibility,
      status: "graceful",
      recommendedVersion: null,
      recommendedRange: ">=2.1.0",
      message: null,
    }),
  ).toEqual({
    title: "Limited support",
    detail: "Use >=2.1.0 for full support.",
    updateCommand: null,
    emphasis: "normal",
    targetVersion: null,
  });
});

describe("provider status copy", () => {
  it("surfaces an ACP-advertised authentication method", () => {
    const provider = {
      enabled: true,
      installed: true,
      status: "error",
      auth: { status: "unauthenticated", type: "agent", label: "Company login" },
      message: "Complete this authentication method on the server.",
    } as ServerProvider;

    expect(getProviderSummary(provider)).toEqual({
      headline: "Not authenticated · Company login",
      detail: "Complete this authentication method on the server.",
    });
  });
});

describe("the selected agent's status", () => {
  const view = (patch: Partial<ServerProvider> = {}, enabled = true) =>
    getProviderStatusView({ ...provider, ...patch }, enabled);

  it("is Signed in with the account and no button when the agent is ready", () => {
    const ready = view({ models: [{ slug: "gpt", name: "GPT", isCustom: false }] as never });
    expect(ready).toMatchObject({
      state: "ready",
      tone: "ready",
      headline: "Signed in",
      detail: null,
      action: null,
      accountIsLastKnown: false,
    });
    expect(ready.account).toEqual(provider.auth);
  });

  it("is Ready, not Signed in, when the agent runs and its sign-in is not reported", () => {
    const ready = view({ auth: { status: "unknown" } });
    expect(ready.headline).toBe("Ready");
    expect(ready.account).toBeNull();
  });

  it("offers Turn on for an agent that is off, whatever the machine last said", () => {
    expect(view({ status: "error", auth: { status: "unauthenticated" } }, false)).toMatchObject({
      state: "off",
      headline: "Off",
      action: "turnOn",
    });
    expect(getProviderStatusView(undefined, false).action).toBe("turnOn");
  });

  it("is Checking with no button until the machine has answered", () => {
    expect(getProviderStatusView(undefined, true)).toMatchObject({
      state: "checking",
      headline: "Checking…",
      action: null,
    });
    expect(view({ installed: false, status: "warning", auth: { status: "unknown" } }).state).toBe(
      "checking",
    );
  });

  it("offers Install for an agent that is not installed, with the machine's reason", () => {
    expect(view({ installed: false, status: "error", auth: { status: "unknown" } })).toMatchObject({
      state: "notInstalled",
      headline: "Not installed",
      detail: null,
      action: "install",
    });
    expect(
      view({
        installed: false,
        status: "error",
        auth: { status: "unknown" },
        message: "CLI not detected on PATH.",
      }).detail,
    ).toBe("CLI not detected on PATH.");
  });

  it("offers Check again to a ready agent that has listed no models", () => {
    expect(view({ models: [] })).toMatchObject({
      state: "ready",
      detail: "No models reported yet. Refresh provider status after completing setup.",
      action: "checkAgain",
    });
  });

  it("offers Sign in, and leaves out the machine's words that say to run a command", () => {
    const signedOut = view({
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Grok CLI is installed but not logged in. Run `grok login`.",
    });
    expect(signedOut).toMatchObject({
      state: "signedOut",
      headline: "Not signed in",
      detail: null,
      action: "signIn",
    });
  });

  it("keeps the last sign-in it read when a check gives no answer, with Check again", () => {
    const lastKnown = { status: "authenticated", email: "ada@example.com", label: "Pro" } as const;
    const noAnswer = view({
      status: "warning",
      auth: { status: "unknown" },
      lastKnownAuth: lastKnown,
      message: "Could not check Codex: no answer in 15 seconds.",
    });
    expect(noAnswer).toMatchObject({
      state: "noAnswer",
      headline: "Could not check Codex: no answer in 15 seconds.",
      action: "checkAgain",
      accountIsLastKnown: true,
    });
    expect(noAnswer.account).toEqual(lastKnown);
    expect(
      view({
        status: "warning",
        auth: { status: "unknown" },
        lastKnownAuth: { status: "unauthenticated" },
        message: "Could not check Codex: no answer in 15 seconds.",
      }),
    ).toMatchObject({ detail: "Last time it was not signed in.", account: null });
  });

  it("gives the machine's reason and Check again for a signed-in agent that is not ready", () => {
    const failing = view({ status: "error", message: "Codex could not list its models." });
    expect(failing).toMatchObject({
      state: "attention",
      headline: "Codex could not list its models.",
      action: "checkAgain",
      accountIsLastKnown: false,
    });
    expect(failing.account).toEqual(provider.auth);
  });

  it("names why an agent is unavailable and offers nothing to press", () => {
    expect(
      view({ availability: "unavailable", unavailableReason: "This build has no such driver." }),
    ).toMatchObject({
      state: "unavailable",
      detail: "This build has no such driver.",
      action: null,
    });
  });

  it("shows the agent's own sign-in under its status only while it is needed", () => {
    const signedOut = {
      ...provider,
      status: "error",
      auth: { status: "unauthenticated" },
    } as const;
    expect(statusRowShowsSetup(signedOut, true)).toBe(true);
    expect(statusRowShowsSetup(signedOut, false)).toBe(false);
    expect(statusRowShowsSetup(provider, true)).toBe(false);
    expect(statusRowShowsSetup(undefined, true)).toBe(false);
    // A check in the middle of a sign-in must not move it back to Setup.
    const noAnswer = { ...provider, status: "warning", auth: { status: "unknown" } } as const;
    expect(statusRowShowsSetup(noAnswer, true)).toBe(true);
    expect(statusRowShowsSetup({ ...provider, status: "error" }, true)).toBe(true);
    expect(
      statusRowShowsSetup({ ...provider, availability: "unavailable", status: "error" }, true),
    ).toBe(false);
    const missing = { ...provider, installed: false, status: "error" } as const;
    expect(statusRowShowsSetup({ ...missing, auth: { status: "unknown" } }, true)).toBe(false);
    expect(
      statusRowShowsSetup(
        {
          ...missing,
          auth: { status: "unknown" },
          setup: { canAuthenticate: true, canInstall: true },
        },
        true,
      ),
    ).toBe(true);
  });
});
