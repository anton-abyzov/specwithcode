import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import { describe, expect, it } from "vite-plus/test";

import { environmentUnavailableBanner } from "../components/chat/environmentUnavailableBanner";
import { threadGroupHeading } from "../components/studio/shell/ThreadsPane";
import { threadCardStatus } from "../studio/projectThreadCards";
import { threadStatusWord } from "../studio/shellModel";
import {
  fleetReachableEnvironmentIds,
  hostDownNote,
  hostDownNoteShown,
  hostDownWord,
  machineReachDetail,
  machineReachWords,
  machineStatus,
  machineUnavailableTitle,
  NEEDS_SIGN_IN_STATUS,
  savedMachineStatus,
} from "./machineStatus";

const DOWN = ["not-answering", "offline", "cant-reach", "stopped"] as const;
const NOT_DOWN = ["connected", "catching-up", "connecting", "reconnecting"] as const;

function shell(): EnvironmentThreadShell {
  return {
    id: "worker-1",
    environmentId: "m5-env",
    projectId: "project-1",
    title: "Read M5 device approval state",
    runtime: { status: "running" },
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: [],
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
    modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
  } as unknown as EnvironmentThreadShell;
}

/** A connection that stopped because this window has no Connect sign-in. */
const SIGNED_OUT = {
  phase: "error",
  error: "Your cloud sign-in changed. Sign in again to authorize the environment.",
  connectSignInRequired: true,
} as const;

/** A machine refusing its own saved credential: pairing again fixes it, not a sign-in. */
const OWN_CREDENTIAL_REFUSED = {
  phase: "error",
  error: "The environment credential is invalid.",
} as const;

describe("the note for a saved machine", () => {
  it("is needs-sign-in only for a connection stopped for want of a Connect sign-in", () => {
    expect(hostDownNote({ connectSignInRequired: true, reachableFromMachine: false })).toBe(
      "needs-sign-in",
    );
    // Signing in is the actionable step, so it wins over the fleet's word.
    expect(hostDownNote({ connectSignInRequired: true, reachableFromMachine: true })).toBe(
      "needs-sign-in",
    );
    expect(hostDownNote({ connectSignInRequired: undefined, reachableFromMachine: true })).toBe(
      "reachable-from-machine",
    );
    expect(hostDownNote({ reachableFromMachine: false })).toBeNull();
  });

  it("reads the machines this machine's server reached from the fleet", () => {
    const snapshot = {
      machines: [
        { id: "m5", environmentId: "m5-env", status: "reachable" },
        { id: "m1", environmentId: "m1-env", status: "unreachable" },
        { id: "linux-mini", environmentId: "mini-env", status: "identity-mismatch" },
      ],
    } as unknown as StudioFleetSnapshot;
    expect([...fleetReachableEnvironmentIds(snapshot)]).toEqual(["m5-env"]);
    expect(fleetReachableEnvironmentIds(null).size).toBe(0);
  });

  it("names a down machine only, never over this device's own lost network", () => {
    for (const state of DOWN) {
      expect(hostDownNoteShown(state, "needs-sign-in")).toBe(true);
      expect(hostDownNoteShown(state, "reachable-from-machine")).toBe(true);
    }
    for (const state of NOT_DOWN) expect(hostDownNoteShown(state, "needs-sign-in")).toBe(false);
    expect(hostDownNoteShown("no-network", "needs-sign-in")).toBe(false);
    expect(hostDownNoteShown(undefined, "needs-sign-in")).toBe(false);
    expect(hostDownNoteShown("stopped", null)).toBe(false);
  });

  it("leaves a machine nobody asked to connect as not connected", () => {
    expect(hostDownNoteShown("not-connected", "reachable-from-machine")).toBe(false);
    expect(hostDownWord("not-connected", false, "reachable-from-machine")).toBe("Not connected");
  });
});

describe("a thread row on a machine that needs sign-in", () => {
  it("says Needs sign-in instead of Not connected", () => {
    expect(hostDownWord("stopped", false, null)).toBe("Not connected");
    expect(hostDownWord("stopped", false, "needs-sign-in")).toBe("Needs sign-in");
    expect(threadStatusWord(shell(), true, "stopped", false, "needs-sign-in")).toBe(
      "Needs sign-in",
    );
    expect(threadCardStatus(shell(), true, "stopped", false, "needs-sign-in").label).toBe(
      "Needs sign-in",
    );
  });

  it("puts a different machine at the address first", () => {
    expect(hostDownWord("stopped", true, "needs-sign-in")).toBe("Different machine at address");
  });

  it("keeps the thread's own word while its machine is reachable", () => {
    expect(threadStatusWord(shell(), false, "connected", false, "needs-sign-in")).not.toBe(
      "Needs sign-in",
    );
  });
});

describe("a machine this machine's server reaches and this window does not", () => {
  it("says Not reachable from here, and keeps retrying words where the window retries", () => {
    expect(hostDownWord("not-answering", false, "reachable-from-machine")).toBe(
      "Not reachable from here",
    );
    expect(hostDownWord("offline", false, "reachable-from-machine")).toBe(
      "Not reachable from here",
    );
    const words = machineReachWords(
      "not-answering",
      "reconnecting",
      false,
      "reachable-from-machine",
    );
    expect(words.headline).toBe("Can't reach {machine} from this window");
    expect(words.next).toBe("Retrying by itself");
  });
});

describe("the machine picker, Settings > Machines and the chat banner", () => {
  it("say Needs sign-in for a connection stopped for want of a sign-in", () => {
    expect(machineStatus(SIGNED_OUT)).toBe(NEEDS_SIGN_IN_STATUS);
    expect(savedMachineStatus(SIGNED_OUT, true)).toMatchObject({
      text: "Needs sign-in",
      retryable: false,
    });
    expect(machineUnavailableTitle("M5", SIGNED_OUT)).toBe("Sign in to reach M5");
  });

  it("keep Connection failed for a machine refusing its own credential", () => {
    expect(machineStatus(OWN_CREDENTIAL_REFUSED).short).toBe("Connection failed");
    expect(savedMachineStatus(OWN_CREDENTIAL_REFUSED, true).text).toBe("Connection failed");
    expect(machineUnavailableTitle("m1", OWN_CREDENTIAL_REFUSED)).toBe("Can't reach m1");
  });

  it("never apply to this machine, which is reached without Connect", () => {
    expect(machineStatus(SIGNED_OUT, true, true)).not.toBe(NEEDS_SIGN_IN_STATUS);
    expect(savedMachineStatus(SIGNED_OUT, true, true).text).not.toBe("Needs sign-in");
  });

  it("give the chat a warning that names the sign-in, with no retry", () => {
    const banner = environmentUnavailableBanner({
      label: "M5",
      connection: SIGNED_OUT,
      isThisMachine: false,
      reach: "stopped",
      note: "needs-sign-in",
    });
    expect(banner.calm).toBe(false);
    expect(banner.variant).toBe("warning");
    expect(banner.title).toBe("Sign in to reach M5");
    expect(banner.status).toBe(NEEDS_SIGN_IN_STATUS);
    expect(banner.describe(null, 0)).toBe(
      "This window reaches it through SpecWithCode Connect and is signed out. Sign in to open it here",
    );
    expect(
      machineReachDetail(machineReachWords("stopped", "error", false, "needs-sign-in"), null, 0),
    ).toContain("Sign in to open it here");
  });
});

describe("the unreachable threads group", () => {
  it("is headed Not reachable from here; other groups keep their names", () => {
    expect(threadGroupHeading("Offline")).toBe("Not reachable from here");
    expect(threadGroupHeading("Working")).toBe("Working");
    expect(threadGroupHeading("Needs you")).toBe("Needs you");
  });
});
