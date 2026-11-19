import type { ProjectSyncStatusResult } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  refreshSyncStatus,
  resetSyncStatusForTest,
  SYNC_STATUS_FRESH_MS,
  syncStatusRead,
  type SyncMachine,
} from "../../studio/projectSync";
import { syncBlockedOn, syncRowFact } from "./useProjectSyncMenu";

vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  runAtomCommand: vi.fn(),
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/session", () => ({ useEnvironmentsScopeAccess: () => new Map() }));
vi.mock("../settings/useReplacedMachineRecords", () => ({
  useRetiredMachineRecords: () => new Map(),
}));

const HEAD = "a".repeat(40);
const status = (head = HEAD, clean = true): ProjectSyncStatusResult => ({
  repositories: [{ path: ".", branch: "main", head, clean }],
  scanLimited: false,
});
const machine = (id: string): SyncMachine => ({
  environmentId: id as never,
  projectId: "p" as never,
  label: id.toUpperCase(),
});
const read = (value = status(), at = 1_000) => ({ kind: "status", status: value, at }) as const;

afterEach(() => resetSyncStatusForTest());

describe("syncBlockedOn", () => {
  const base = { machine: "M5", reach: "open", read: undefined, version: null } as const;

  it("lets Sync run on a connected machine whose grant allows it or has not loaded", () => {
    expect(syncBlockedOn({ ...base, access: "granted" })).toBeNull();
    expect(syncBlockedOn({ ...base, access: "unknown" })).toBeNull();
    expect(syncBlockedOn({ ...base, access: undefined })).toBeNull();
  });

  it("greys it for an offline machine, an app from before Sync, and a window that can only read", () => {
    expect(syncBlockedOn({ ...base, reach: "offline", access: "granted" })).toEqual({
      text: "{machine} offline",
      values: { machine: "M5" },
    });
    expect(
      syncBlockedOn({
        ...base,
        read: { kind: "needs-update", at: 1 },
        version: "1.0.360",
        access: "granted",
      }),
    ).toEqual({ text: "Needs update · {version}", values: { version: "1.0.360" } });
    expect(
      syncBlockedOn({ ...base, read: { kind: "needs-update", at: 1 }, access: "granted" }),
    ).toEqual({ text: "Needs update" });
    expect(syncBlockedOn({ ...base, access: "denied" })).toEqual({
      text: "This window can only read {machine}",
      values: { machine: "M5" },
    });
  });
});

describe("syncRowFact", () => {
  const base = { shownName: "M5", offline: false, version: null } as const;

  it("compares the two machines' last statuses", () => {
    expect(syncRowFact({ ...base, shown: read(), other: read() }).sync).toMatchObject({
      tone: "same",
      text: "Same as {shown}",
    });
    expect(
      syncRowFact({ ...base, shown: read(), other: read(status("b".repeat(40))) }).sync,
    ).toMatchObject({ tone: "differs", values: { k: "1", n: "1" } });
  });

  it("falls back to Not checked yet for a machine that could not be asked", () => {
    expect(syncRowFact({ ...base, shown: read(), other: undefined })).toEqual({
      sync: { tone: "unknown", text: "Not checked yet" },
      needsUpdate: null,
    });
    expect(syncRowFact({ ...base, shown: undefined, other: read() }).sync?.tone).toBe("unknown");
  });

  it("marks a machine from before Sync, and never compares it", () => {
    expect(
      syncRowFact({
        ...base,
        shown: read(),
        other: { kind: "needs-update", at: 1 },
        version: "1.0.360",
      }),
    ).toEqual({
      sync: { tone: "unknown", text: "Not checked yet" },
      needsUpdate: { version: "1.0.360" },
    });
  });

  it("says when an offline machine's status was read", () => {
    const fact = syncRowFact({ ...base, shown: read(), other: read(status(), 0), offline: true });
    expect(fact.sync?.text).toBe("Same as {shown} · as of {time}");
    expect(fact.sync?.values?.time).toBeTruthy();
  });
});

describe("refreshSyncStatus", () => {
  it("reads a status once and keeps it for a minute", async () => {
    let now = 10_000;
    const api = { status: vi.fn(async () => ({ ok: true as const, value: status() })) };
    await refreshSyncStatus([machine("m4"), machine("m5")], api, () => now);
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(syncStatusRead("m4:p")).toEqual({ kind: "status", status: status(), at: 10_000 });
    now += SYNC_STATUS_FRESH_MS - 1;
    await refreshSyncStatus([machine("m4")], api, () => now);
    expect(api.status).toHaveBeenCalledTimes(2);
    now += 1;
    await refreshSyncStatus([machine("m4")], api, () => now);
    expect(api.status).toHaveBeenCalledTimes(3);
  });

  it("keeps the last status of a machine that cannot be asked, and nothing for one never read", async () => {
    let now = 0;
    const answers: Array<
      { ok: true; value: ProjectSyncStatusResult } | { ok: false; cause: unknown }
    > = [
      { ok: true, value: status() },
      { ok: false, cause: { _tag: "EnvironmentRpcUnavailableError" } },
      { ok: false, cause: { _tag: "EnvironmentRpcUnavailableError" } },
    ];
    const api = { status: vi.fn(async () => answers.shift()!) };
    await refreshSyncStatus([machine("m4")], api, () => now);
    now += SYNC_STATUS_FRESH_MS;
    await refreshSyncStatus([machine("m4"), machine("m5")], api, () => now);
    expect(syncStatusRead("m4:p")).toEqual({ kind: "status", status: status(), at: 0 });
    expect(syncStatusRead("m5:p")).toBeUndefined();
  });

  it("reads only an unknown call as needing an update", async () => {
    const api = {
      status: vi.fn(async () => ({
        ok: false as const,
        cause: "Unknown request tag: projectSync.status",
      })),
    };
    await refreshSyncStatus([machine("m1")], api, () => 5);
    expect(syncStatusRead("m1:p")).toEqual({ kind: "needs-update", at: 5 });
  });
});
