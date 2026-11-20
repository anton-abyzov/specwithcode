import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import { describe, expect, it } from "vite-plus/test";

import { environmentUnavailableBanner } from "../components/chat/environmentUnavailableBanner";
import { threadMachinePresentation } from "../components/chat/threadMachine";
import { threadCardStatus } from "../studio/projectThreadCards";
import { composerHostStatus, hostDisconnectedLabel } from "../studio/projectWorkspaceModel";
import { threadStatusWord } from "../studio/shellModel";
import {
  hostDownWord,
  identityMismatchedEnvironmentIds,
  identityMismatchShown,
  machineReachDetail,
  machineReachWords,
} from "./machineStatus";

const HEADLINE = "{machine}'s address now answers as a different SpecWithCode";
const ACTION = "Open Settings > Machines to fix it.";
const DOWN = ["not-answering", "offline", "cant-reach", "stopped", "not-connected"] as const;
const NOT_DOWN = ["connected", "catching-up", "connecting", "reconnecting"] as const;

function shell(): EnvironmentThreadShell {
  return {
    id: "worker-1",
    environmentId: "dd2fc230-env",
    projectId: "project-1",
    title: "Worker",
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
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-17T00:00:00Z",
    modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
  } as unknown as EnvironmentThreadShell;
}

describe("identityMismatchedEnvironmentIds", () => {
  it("lists the saved environment id of each machine the fleet marks identity-mismatch", () => {
    const snapshot = {
      machines: [
        { id: "ministorm", environmentId: "dd2fc230-env", status: "identity-mismatch" },
        { id: "m1", environmentId: "m1-env", status: "unreachable" },
        { id: "m4", environmentId: "m4-env", status: "reachable" },
      ],
    } as unknown as StudioFleetSnapshot;
    expect([...identityMismatchedEnvironmentIds(snapshot)]).toEqual(["dd2fc230-env"]);
  });

  it("is empty without a fleet", () => {
    expect(identityMismatchedEnvironmentIds(null).size).toBe(0);
    expect(identityMismatchedEnvironmentIds(undefined).size).toBe(0);
  });
});

describe("identity-mismatch words", () => {
  it("apply only while the machine is down, and never over this device's own lost network", () => {
    for (const state of DOWN) expect(identityMismatchShown(state, true)).toBe(true);
    for (const state of NOT_DOWN) expect(identityMismatchShown(state, true)).toBe(false);
    expect(identityMismatchShown("no-network", true)).toBe(false);
    expect(identityMismatchShown("offline", false)).toBe(false);
    expect(identityMismatchShown(undefined, true)).toBe(false);
  });

  it("name the address answering as another SpecWithCode, with the fix and no retry", () => {
    const words = machineReachWords("offline", "reconnecting", true);
    expect(words.headline).toBe(HEADLINE);
    expect(words.short).toBe("Different machine at address");
    expect(words.next).toBeNull();
    expect(words.action).toBe(ACTION);
    expect(machineReachDetail(words, null, 0)).toBe("Open Settings > Machines to fix it");
    // A translated action ending in an ideographic full stop does not get a second stop.
    expect(machineReachDetail(words, null, 0, () => "「設定 > マシン」を開いてください。")).toBe(
      "「設定 > マシン」を開いてください",
    );
    // Wins over the update ask: the update would not reach the right machine either.
    expect(machineReachWords("stopped", "unsupported", true).headline).toBe(HEADLINE);
  });

  it("leave every word as today without the fleet's mark", () => {
    expect(machineReachWords("offline", "reconnecting").headline).toBe("{machine} is offline");
    expect(machineReachWords("offline", "reconnecting", false).next).toBe("Retrying by itself");
    expect(machineReachWords("reconnecting", "reconnecting", true).headline).toBe(
      "Reconnecting to {machine}…",
    );
    expect(machineReachWords("no-network", "offline", true).headline).toBe(
      "This device has no network",
    );
  });
});

describe("a thread row on a machine at a mismatched address", () => {
  it("says Different machine at address instead of Host offline", () => {
    expect(hostDownWord("offline", true)).toBe("Different machine at address");
    expect(hostDownWord("cant-reach", true)).toBe("Different machine at address");
    // Only while it is down, as everywhere else.
    expect(hostDownWord("reconnecting", true)).toBe("Host offline");
    expect(hostDownWord("connected", true)).toBe("Host offline");
    expect(hostDownWord(undefined, true)).toBe("Host offline");
    expect(threadStatusWord(shell(), true, "offline", true)).toBe("Different machine at address");
    expect(threadCardStatus(shell(), true, "offline", true).label).toBe(
      "Different machine at address",
    );
  });

  it("keeps today's word without the mark, or when this device has no network", () => {
    expect(threadStatusWord(shell(), true, "offline")).toBe("Host offline");
    expect(threadStatusWord(shell(), true, "offline", false)).toBe("Host offline");
    expect(threadStatusWord(shell(), true, "no-network", true)).toBe("No network");
    // A connected machine's row shows its own state, mark or not.
    expect(threadStatusWord(shell(), false, "connected", true)).toBe("Working");
  });
});

describe("the chat banner for a machine at a mismatched address", () => {
  const input = {
    label: "linux-mini",
    connection: { phase: "reconnecting" as const, error: "Cloudflare 1033" },
    isThisMachine: false,
    reach: "offline" as const,
  };

  it("says the address answers as a different SpecWithCode and how to fix it, with no retry", () => {
    const banner = environmentUnavailableBanner({ ...input, identityMismatch: true });
    expect(banner.calm).toBe(false);
    expect(banner.title).toBe("linux-mini's address now answers as a different SpecWithCode");
    const detail = banner.describe(null, Date.now());
    expect(detail).toBe("Open Settings > Machines to fix it");
    expect(detail).not.toContain("Retrying by itself");
    expect(banner.status.retryable).toBe(false);
    expect(banner.status.text).not.toContain("Retrying by itself");
  });

  it("keeps today's banner without the mark", () => {
    const banner = environmentUnavailableBanner(input);
    expect(banner.title).toBe("linux-mini is offline");
    expect(banner.describe(null, Date.now())).toContain("Retrying by itself");
  });
});

describe("the composer line for a machine at a mismatched address", () => {
  const context = {
    isThisDevice: false,
    graceElapsed: true,
    machineLabel: "linux-mini",
    reach: "offline" as const,
  };
  const connection = { phase: "reconnecting" };

  it("names the mismatch and the step to fix it, never a retry", () => {
    const status = composerHostStatus(connection, { ...context, identityMismatch: true });
    expect(status.tone).toBe("offline");
    expect(status.headline).toBe(HEADLINE);
    expect(status.machine).toBe("linux-mini");
    expect(status.progress).toBeNull();
    expect(status.action).toBe(ACTION);
    expect(hostDisconnectedLabel(connection, { ...context, identityMismatch: true })).toBe(
      "Different machine at address",
    );
  });

  it("keeps today's line without the mark", () => {
    const status = composerHostStatus(connection, context);
    expect(status.headline).toBe("{machine} is offline");
    expect(status.progress).toBe("Retrying by itself");
    expect(status.action).toBeNull();
    expect(hostDisconnectedLabel(connection, context)).toBe("Offline");
  });

  it("stays calm while the machine is only reconnecting", () => {
    const status = composerHostStatus(connection, {
      ...context,
      reach: "reconnecting",
      identityMismatch: true,
    });
    expect(status.tone).toBe("connecting");
    expect(status.action).toBeNull();
  });
});

describe("the thread header chip for a machine at a mismatched address", () => {
  const base = {
    name: "linux-mini",
    hostLabel: "linux-mini",
    kind: "laptop" as const,
    os: "linux" as const,
    isThisMachine: false,
    phase: "error" as const,
    error: "environment id mismatch",
    canOperate: true,
    handoff: "none" as const,
  };

  it("says Different machine at address and never Retrying by itself", () => {
    const machine = threadMachinePresentation({ ...base, identityMismatch: true });
    expect(machine.warning).toBe("Different machine at address");
    expect(machine.tip).toContain("Open Settings > Machines to fix it.");
    expect(machine.tip).not.toContain("Retrying by itself");
  });

  it("keeps today's chip without the mark", () => {
    expect(threadMachinePresentation(base).warning).toBe("Connection failed");
  });
});
