import { describe, expect, it } from "vite-plus/test";

import { overviewMachineState } from "./overviewMachines";
import { hostReachStatus } from "./hostLimitsModel";
import {
  composerHostStatus,
  hostDisconnectedLabel,
  projectAdmissionReason,
} from "./projectWorkspaceModel";
import { threadResolveBlockedReason } from "./threadResolveAccess";
import { threadRenameBlockedReason } from "./threadTitles";

/** Refused because this window has no Connect sign-in, after Clerk said signed out. */
const SIGNED_OUT = {
  phase: "error",
  error: "Sign in to SpecWithCode Connect to connect this environment.",
  blockedReason: "authentication",
  connectSignInRequired: true,
} as const;
/** A machine refusing its own saved credential: pairing again fixes it. */
const CREDENTIAL_REFUSED = { phase: "error", blockedReason: "authentication" } as const;
const REMOTE = { isThisDevice: false, graceElapsed: true, machineLabel: "Office Mac" } as const;

describe("the composer and workspace words for a machine that needs a Connect sign-in (1417)", () => {
  it("name the sign-in, not a browser signed out of the host", () => {
    expect(hostDisconnectedLabel(SIGNED_OUT, REMOTE)).toBe("Needs sign-in");
    expect(composerHostStatus(SIGNED_OUT, REMOTE)).toMatchObject({
      tone: "signed-out",
      headline: "Sign in to reach {machine}",
      action: "Sign in to SpecWithCode Connect to reach it from this window.",
    });
    expect(projectAdmissionReason(null, false, true, SIGNED_OUT, REMOTE)).toBe(
      "This window is signed out of SpecWithCode Connect. Sign in to reach this machine.",
    );
  });

  it("keep today's words for a machine's own credential refusal", () => {
    expect(hostDisconnectedLabel(CREDENTIAL_REFUSED, REMOTE)).toBe("Signed out");
    expect(composerHostStatus(CREDENTIAL_REFUSED, REMOTE).headline).toBe("Signed out of {machine}");
  });

  it("never apply to this device", () => {
    const here = { isThisDevice: true, graceElapsed: true } as const;
    expect(hostDisconnectedLabel(SIGNED_OUT, here)).toBe("Signed out");
    expect(composerHostStatus(SIGNED_OUT, here).headline).toBe("This window is signed out");
  });
});

describe("resolve and rename on a machine that needs a Connect sign-in", () => {
  it("say the window is signed out of Connect", () => {
    expect(
      threadResolveBlockedReason({
        access: "unknown",
        connection: SIGNED_OUT,
        machinesLoaded: true,
        supportsSettlement: true,
        environmentId: "office",
        machineLabel: "Office Mac",
        action: "resolve",
        needsSettlement: true,
      }),
    ).toBe(
      "This window is signed out of SpecWithCode Connect. Sign in to reach Office Mac and resolve this thread.",
    );
    expect(
      threadRenameBlockedReason({
        canOperate: true,
        connection: SIGNED_OUT,
        environmentId: "office",
        machineLabel: "Office Mac",
      }),
    ).toBe(
      "This window is signed out of SpecWithCode Connect. Sign in to reach Office Mac and rename this thread.",
    );
  });
});

describe("the overview and usage limits", () => {
  it("say Needs sign-in for a stopped machine with the note", () => {
    expect(
      overviewMachineState({
        reach: "stopped",
        reported: true,
        stale: false,
        note: "needs-sign-in",
      }).state,
    ).toBe("Needs sign-in");
    expect(overviewMachineState({ reach: "stopped", reported: true, stale: false }).state).toBe(
      "Connection failed",
    );
    expect(hostReachStatus(SIGNED_OUT as never, false, Date.now(), "needs-sign-in").word).toBe(
      "Needs sign-in",
    );
  });
});
