// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - disposable real Git fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { folderCopyAllConflictsKey } from "@specweave-studio/contracts";

import { CopyError, DestinationCopies, type DestinationRecord } from "./destinationService.ts";
import { git, makeUmbrella, write, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import { repoRowId } from "./reconcile.ts";
import { SourceTransfers, type SourceOperationRecord } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";

let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
const released: Array<{ operationId: string; reason: string }> = [];

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-dest-")));
  fixture = makeUmbrella(base);
  transfers = new SourceTransfers(NodePath.join(base, "source-state"), {
    release: async (record: SourceOperationRecord, reason: string) => {
      released.push({ operationId: record.operationId, reason });
    },
  });
  served = await serveSource(transfers, "env-source");
}, 60_000);
afterAll(async () => {
  if (served !== undefined) await served.close();
  NodeFS.rmSync(base, { recursive: true, force: true });
});

const fast = { allowLoopback: true, sleep: async () => undefined, pollMs: 20 } as const;

async function settle(
  copies: DestinationCopies,
  operationId: string,
  until: ReadonlyArray<string>,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await copies.waitFor(operationId);
    const record = await copies.read(operationId);
    if (record && until.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`copy ${operationId} never reached ${until.join(", ")}`);
}

async function offer(mode: "copy-only" | "copy-and-move" = "copy-only") {
  const operationId = NodeCrypto.randomUUID();
  const offered = await transfers.offer({
    operationId,
    projectId: "project-source",
    folder: fixture.root,
    mode,
    destinationEnvironmentId: "env-destination",
  });
  return { operationId, token: offered.token };
}

const startInput = (operationId: string, token: string, target: string, mode = "copy-only") => ({
  operationId,
  sourceUrl: served.url,
  token,
  sourceEnvironmentId: "env-source",
  sourceProjectId: "project-source",
  sourceMachine: "M4MAX",
  mode: mode as "copy-only" | "copy-and-move",
  targetFolder: target,
  title: "Umbrella",
});

describe("DestinationCopies", () => {
  it("previews, approves, applies, commits the source and registers the folder", async () => {
    const registered: Array<DestinationRecord> = [];
    const copies = new DestinationCopies(NodePath.join(base, "dest-state-a"), {
      ...fast,
      register: async (record) => {
        registered.push(record);
        return "project-copied";
      },
    });
    const { operationId, token } = await offer();
    const target = NodePath.join(base, "targets", "a");
    await copies.start(startInput(operationId, token, target));
    const previewed = await settle(copies, operationId, ["previewed", "failed"]);
    expect(previewed.error).toBeNull();
    expect(NodeFS.existsSync(target)).toBe(false);
    const plan = await copies.readPlan(operationId);
    expect(plan?.totals.decisionsNeeded).toBe(0);
    await copies.approve(operationId);
    const applied = await settle(copies, operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    expect(applied.checks.filter((check) => !check.ok)).toEqual([]);
    expect(applied.committed).toBe(true);
    expect(applied.projectId).toBe("project-copied");
    expect(registered).toHaveLength(1);
    expect(git(NodePath.join(target, "repositories/svc-b"), "stash", "list")).toContain(
      "stash@{0}",
    );
    expect(NodeFS.existsSync(NodePath.join(target, ".env"))).toBe(false);
    expect((await transfers.read(operationId))?.state).toBe("committed");
    // The staging folder is gone once Apply finished.
    expect(
      NodeFS.existsSync(NodePath.join(base, "dest-state-a/folder-copies", operationId, "staging")),
    ).toBe(false);
  }, 120_000);

  it("refuses early when the destination lacks the space the copy needs", async () => {
    const copies = new DestinationCopies(NodePath.join(base, "dest-state-b"), {
      ...fast,
      freeBytes: async () => 1,
    });
    const { operationId, token } = await offer();
    const target = NodePath.join(base, "targets", "b");
    await copies.start(startInput(operationId, token, target));
    await settle(copies, operationId, ["previewed"]);
    const error = await copies.approve(operationId).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CopyError);
    expect((error as CopyError).code).toBe("disk_space");
    expect((error as CopyError).detail.needed).toBeGreaterThan(1);
    expect((error as CopyError).message).toMatch(/needs .* free here/);
    expect((await copies.read(operationId))?.state).toBe("previewed");
    expect(NodeFS.existsSync(target)).toBe(false);
  }, 60_000);

  it("releases a copy-and-move source with a reason when the copy is cancelled before Apply", async () => {
    const copies = new DestinationCopies(NodePath.join(base, "dest-state-c"), fast);
    const { operationId, token } = await offer("copy-and-move");
    const target = NodePath.join(base, "targets", "c");
    await copies.start(startInput(operationId, token, target, "copy-and-move"));
    await settle(copies, operationId, ["previewed"]);
    const cancelled = await copies.cancel(operationId, "Changed my mind");
    expect(cancelled.state).toBe("cancelled");
    expect((await transfers.read(operationId))?.state).toBe("released");
    expect(released.find((entry) => entry.operationId === operationId)?.reason).toContain(
      "Changed my mind",
    );
    expect(NodeFS.existsSync(target)).toBe(false);
  }, 60_000);

  it("drops a failed preview's counts and refuses Retry before Apply with what to do", async () => {
    let calls = 0;
    const copies = new DestinationCopies(NodePath.join(base, "dest-state-retry"), {
      ...fast,
      // The source is still reading its list on the first poll; the link then drops.
      sleep: async () => {
        calls += 1;
        throw new Error("Connection reset while reading the source list.");
      },
    });
    const { operationId, token } = await offer();
    const target = NodePath.join(base, "targets", "retry");
    await copies.start(startInput(operationId, token, target));
    const failed = await settle(copies, operationId, ["failed", "previewed"]);
    expect(calls).toBe(1);
    expect(failed).toMatchObject({ state: "failed", failedStep: "scanning", progress: null });
    const error = await copies.retry(operationId).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "refused" });
    expect((error as CopyError).message).toBe(
      "Nothing was changed on this machine. Start the copy again from the source.",
    );
    expect(NodeFS.existsSync(target)).toBe(false);
  }, 60_000);

  it("refuses an older source that has no folder copy", async () => {
    const copies = new DestinationCopies(NodePath.join(base, "dest-state-d"), {
      ...fast,
      fetch: async () => new Response("not found", { status: 404 }),
    });
    const error = await copies
      .start(startInput(NodeCrypto.randomUUID(), "token", NodePath.join(base, "targets", "d")))
      .catch((cause: unknown) => cause);
    expect((error as CopyError).code).toBe("outdated_source");
  });

  it("resumes an interrupted Apply after a restart and asks before undoing edited files", async () => {
    const state = NodePath.join(base, "dest-state-e");
    const target = NodePath.join(base, "targets", "e");
    const first = new DestinationCopies(state, fast);
    const { operationId, token } = await offer();
    await first.start(startInput(operationId, token, target));
    await settle(first, operationId, ["previewed"]);
    await first.approve(operationId);
    await settle(first, operationId, ["applied"]);
    // Simulate a crash mid-Apply: the record says applying and the journal is partial.
    const directory = NodePath.join(state, "folder-copies", operationId);
    const recordFile = NodePath.join(directory, "operation.json");
    const record = JSON.parse(NodeFS.readFileSync(recordFile, "utf8")) as DestinationRecord;
    NodeFS.writeFileSync(
      recordFile,
      JSON.stringify({ ...record, state: "applying", committed: true, projectId: "p" }),
    );
    const second = new DestinationCopies(state, fast);
    await second.resume();
    const resumed = await settle(second, operationId, ["applied", "failed"]);
    expect({ state: resumed.state, error: resumed.error }).toEqual({
      state: "applied",
      error: null,
    });
    expect(resumed.checks.filter((check) => !check.ok)).toEqual([]);

    write(NodePath.join(target, "README.md"), "edited after apply\n");
    const asked = await second.undo(operationId, false);
    expect(asked.result).toBeNull();
    expect(asked.preview.edited).toBeGreaterThan(0);
    expect((await second.read(operationId))?.state).toBe("applied");
  }, 120_000);

  it("re-plans with decisions when the target already holds a diverged copy", async () => {
    const copies = new DestinationCopies(NodePath.join(base, "dest-state-f"), fast);
    const target = NodePath.join(base, "targets", "f");
    // An older clone of svc-b with a commit only here, while the source moved on.
    NodeFS.mkdirSync(NodePath.join(target, "repositories"), { recursive: true });
    git(
      NodePath.join(target, "repositories"),
      "clone",
      "-q",
      NodePath.join(fixture.origins, "svc-b.git"),
      "svc-b",
    );
    const serviceB = NodePath.join(target, "repositories/svc-b");
    write(NodePath.join(serviceB, "src/dest-only.ts"), "destination commit\n");
    git(serviceB, "add", "-A");
    git(serviceB, "commit", "-q", "-m", "destination-only commit");
    git(
      NodePath.join(fixture.root, "repositories/svc-b"),
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "source-only commit",
    );
    const { operationId, token } = await offer();
    await copies.start(startInput(operationId, token, target));
    await settle(copies, operationId, ["previewed"]);
    const plan = await copies.readPlan(operationId);
    const row = plan?.rows.find((candidate) => candidate.id === repoRowId("repositories/svc-b"));
    expect(row?.status).toBe("diverged");
    expect(plan?.totals.decisionsNeeded).toBeGreaterThan(0);
    expect(plan?.rows.some((candidate) => candidate.conflicts.length > 0)).toBe(true);
    await expect(copies.approve(operationId)).rejects.toThrow(/decision/);
    const decisions = Object.fromEntries(
      (plan?.rows ?? []).flatMap((candidate) => [
        ...(candidate.needsDecision ? [[candidate.id, candidate.choices[0]!] as const] : []),
        ...(candidate.conflicts.some((conflict) => conflict.decision === null)
          ? [[folderCopyAllConflictsKey(candidate.id), "keep-mine" as const] as const]
          : []),
      ]),
    );
    await copies.decide(operationId, { decisions });
    await settle(copies, operationId, ["previewed"]);
    expect((await copies.readPlan(operationId))?.totals.decisionsNeeded).toBe(0);
  }, 120_000);
});

describe("Apply backups", () => {
  it("are discarded after the retention, after which Undo is refused", async () => {
    const state = NodePath.join(base, "dest-state-g");
    let now = new Date("2026-10-20T12:00:00.000Z");
    const copies = new DestinationCopies(state, { ...fast, now: () => now });
    const { operationId, token } = await offer();
    await copies.start(startInput(operationId, token, NodePath.join(base, "targets", "g")));
    await settle(copies, operationId, ["previewed"]);
    await copies.approve(operationId);
    await settle(copies, operationId, ["applied"]);
    now = new Date("2026-11-02T12:00:00.000Z");
    expect(await copies.discardExpiredBackups()).toEqual([]);
    expect((await copies.undoPreview(operationId)).items.length).toBeGreaterThan(0);
    now = new Date("2026-11-04T12:00:01.000Z");
    expect(await copies.discardExpiredBackups()).toEqual([operationId]);
    const record = await copies.read(operationId);
    expect(record?.state).toBe("applied");
    expect(record?.backupsDiscardedAt).toBe(now.toISOString());
    expect(NodeFS.existsSync(NodePath.join(state, "folder-copies", operationId, "backups"))).toBe(
      false,
    );
    await expect(copies.undo(operationId, false)).rejects.toThrow(/nothing to undo/);
  }, 120_000);
  it("sends only the ticked secret files, privately, and Undo removes them", async () => {
    const state = NodePath.join(base, "dest-state-secrets");
    const copies = new DestinationCopies(state, fast);
    const { operationId, token } = await offer();
    const target = NodePath.join(base, "targets", "secrets");
    await copies.start(startInput(operationId, token, target));
    await settle(copies, operationId, ["previewed"]);
    const offered = (await transfers.read(operationId))?.summary?.secretFiles ?? [];
    expect(offered.map((file) => file.path)).toContain(".env");
    await expect(
      transfers.approveSecrets({ operationId, paths: ["README.md"], destinationLabel: "M3" }),
    ).rejects.toMatchObject({ status: 400, code: "not_offered" });
    // A secret file the dialog saw in a later scan than the record's is still accepted.
    const late = NodePath.join(fixture.root, ".dev.vars");
    NodeFS.writeFileSync(late, "LATE=fixture\n");
    try {
      const withLate = await transfers.approveSecrets({
        operationId,
        paths: [".env", ".dev.vars"],
        destinationLabel: "M3",
      });
      expect(withLate.secrets?.files).toEqual([
        expect.objectContaining({ path: ".env" }),
        { path: ".dev.vars", size: 13 },
      ]);
    } finally {
      NodeFS.rmSync(late);
    }
    await expect(
      transfers.approveSecrets({ operationId, paths: [".dev.vars"], destinationLabel: "M3" }),
    ).rejects.toMatchObject({ status: 400, code: "not_offered" });
    const approved = await transfers.approveSecrets({
      operationId,
      paths: [".env"],
      destinationLabel: "M3",
    });
    expect(approved.secrets?.files.map((file) => file.path)).toEqual([".env"]);
    await copies.approve(operationId);
    const applied = await settle(copies, operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    expect(applied.secrets).toEqual([
      expect.objectContaining({ path: ".env", writtenAs: ".env", state: "written" }),
    ]);
    const env = NodePath.join(target, ".env");
    expect(NodeFS.readFileSync(env, "utf8")).toBe("API_TOKEN=fixture-not-a-secret\n");
    // Windows has no POSIX mode bits to check.
    if (process.platform !== "win32") expect(NodeFS.statSync(env).mode & 0o777).toBe(0o600);
    const sent = await transfers.sentSecrets.list("env-destination");
    expect(sent.filter((entry) => entry.operationId === operationId)).toEqual([
      expect.objectContaining({ path: ".env", destinationLabel: "M3", size: offered[0]!.size }),
    ]);
    const records = NodeFS.readFileSync(
      NodePath.join(state, "folder-copies", operationId, "operation.json"),
      "utf8",
    );
    expect(records).not.toContain("fixture-not-a-secret");
    const undone = await copies.undo(operationId, false);
    expect(undone.result).not.toBeNull();
    expect(NodeFS.existsSync(env)).toBe(false);
  }, 120_000);
});

describe("Backup expiry", () => {
  it("keeps the files a forced Undo moved aside", async () => {
    const state = NodePath.join(base, "dest-state-h");
    let now = new Date("2026-10-20T12:00:00.000Z");
    const copies = new DestinationCopies(state, { ...fast, now: () => now });
    const { operationId, token } = await offer();
    await copies.start(startInput(operationId, token, NodePath.join(base, "targets", "h")));
    await settle(copies, operationId, ["previewed"]);
    await copies.approve(operationId);
    await settle(copies, operationId, ["applied"]);
    const backups = NodePath.join(state, "folder-copies", operationId, "backups");
    const keptEdit = NodePath.join(backups, "kept-edits", "notes.md");
    const undoneClone = NodePath.join(backups, "undone-clones", "svc", "HEAD");
    for (const file of [keptEdit, undoneClone]) {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, "mine\n");
    }
    now = new Date("2026-11-04T12:00:01.000Z");
    expect(await copies.discardExpiredBackups()).toEqual([operationId]);
    expect(NodeFS.readFileSync(keptEdit, "utf8")).toBe("mine\n");
    expect(NodeFS.readFileSync(undoneClone, "utf8")).toBe("mine\n");
    expect(NodeFS.existsSync(NodePath.join(backups, "files"))).toBe(false);
  }, 120_000);
});

describe("A re-offered copy", () => {
  it("keeps the newer token from a repeated start before the transfer begins", async () => {
    const copies = new DestinationCopies(NodePath.join(base, "dest-state-reoffer"), fast);
    const { operationId, token } = await offer();
    const target = NodePath.join(base, "targets", "reoffer");
    await copies.start(startInput(operationId, token, target));
    await settle(copies, operationId, ["previewed", "failed"]);
    // The source offers again: a new token, and the first one stops working.
    const again = await transfers.offer({
      operationId,
      projectId: "project-source",
      folder: fixture.root,
      mode: "copy-only",
      destinationEnvironmentId: "env-destination",
    });
    expect(again.token).not.toBe(token);
    const restarted = await copies.start(startInput(operationId, again.token, target));
    expect(restarted.token).toBe(again.token);
    expect((await copies.read(operationId))?.token).toBe(again.token);
    await copies.approve(operationId);
    const applied = await settle(copies, operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    expect(applied.committed).toBe(true);
    // Once applied, a later start with yet another token changes nothing.
    expect((await copies.start(startInput(operationId, "stale-token", target))).token).toBe(
      again.token,
    );
  }, 120_000);
});

describe("Clone from origin on a machine without access", () => {
  const unreachable = "https://127.0.0.1:9/acme/svc-a.git";
  let root: string;
  beforeAll(() => {
    root = makeUmbrella(NodePath.join(base, "no-access")).root;
    git(NodePath.join(root, "repositories/svc-a"), "remote", "set-url", "origin", unreachable);
  }, 60_000);

  async function previewWithClone(copies: DestinationCopies, target: string) {
    const operationId = NodeCrypto.randomUUID();
    const offered = await transfers.offer({
      operationId,
      projectId: "project-source",
      folder: root,
      mode: "copy-only",
      destinationEnvironmentId: "env-destination",
    });
    await copies.start(startInput(operationId, offered.token, target));
    await settle(copies, operationId, ["previewed", "failed"]);
    await copies.decide(operationId, { clone: [repoRowId("repositories/svc-a")] });
    await settle(copies, operationId, ["previewed", "failed"]);
    return operationId;
  }

  it("copies a repository with its history when this machine cannot read its origin", async () => {
    const copies = new DestinationCopies(NodePath.join(base, "dest-state-no-access"), {
      ...fast,
      reachableOrigin: async () => null,
    });
    const target = NodePath.join(base, "targets", "no-access");
    const operationId = await previewWithClone(copies, target);
    const plan = await copies.readPlan(operationId);
    const row = plan?.rows.find((entry) => entry.id === repoRowId("repositories/svc-a"));
    expect(row).toMatchObject({ cloneAvailable: false, clone: false });
    expect(plan?.git.find((step) => step.repo === "repositories/svc-a")?.kind).toBe("copy");
    await copies.approve(operationId);
    const applied = await settle(copies, operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    expect(git(NodePath.join(target, "repositories/svc-a"), "rev-parse", "HEAD")).toBe(
      git(NodePath.join(root, "repositories/svc-a"), "rev-parse", "HEAD"),
    );
  }, 120_000);

  it("names the repository when a clone still fails, and Retry tries it again", async () => {
    const copies = new DestinationCopies(NodePath.join(base, "dest-state-clone-fails"), {
      ...fast,
      // The preview saw the origin answer; it stopped answering before Apply.
      reachableOrigin: async (origin) => origin,
    });
    const target = NodePath.join(base, "targets", "clone-fails");
    const operationId = await previewWithClone(copies, target);
    await copies.approve(operationId);
    const failed = await settle(copies, operationId, ["applied", "failed"]);
    expect(failed).toMatchObject({ state: "failed", failedStep: "applying" });
    expect(failed.error?.message).toContain("Cloning repositories/svc-a from origin failed");
    expect(failed.error?.message).toContain("gh auth login");
    // Retry does not skip the clone the journal named before it ran.
    await copies.retry(operationId);
    const again = await settle(copies, operationId, ["applied", "failed"]);
    expect(again.error?.message).toContain("Cloning repositories/svc-a");
  }, 120_000);
});
