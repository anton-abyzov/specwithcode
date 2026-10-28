// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable Undo fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

import { copyStatus, undoResult } from "../FolderCopyHandoff.ts";
import type { JournalEntry } from "./apply.ts";
import { DestinationCopies, type DestinationRecord } from "./destinationService.ts";
import { JsonLog } from "./durable.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFSP>()),
}));

it.each([true, false])(
  "keeps incomplete Undo recoverable across reload and retention (committed: %s)",
  async (committed) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-undo-recovery-"));
    const operationId = NodeCrypto.randomUUID();
    const target = NodePath.join(root, "target");
    const operation = NodePath.join(root, "state", "folder-copies", operationId);
    const backup = NodePath.join(operation, "backups", "files", "report");
    const journal = NodePath.join(operation, "journal.ndjson");
    const to = NodePath.join(target, "report");
    let clock = new Date();
    let releases = 0;
    const copies = () =>
      new DestinationCopies(NodePath.join(root, "state"), {
        now: () => clock,
        fetch: async (url) => {
          if (String(url).endsWith("/hello"))
            return Response.json({ environmentId: "source", operationId, state: "ready" });
          if (String(url).endsWith("/release")) {
            releases += 1;
            return Response.json({ state: "released" });
          }
          throw new Error(`Unexpected fixture request: ${url}`);
        },
      });
    const first = copies();
    let second: DestinationCopies | undefined;
    try {
      NodeFS.mkdirSync(target, { recursive: true });
      NodeFS.mkdirSync(NodePath.dirname(backup), { recursive: true });
      NodeFS.writeFileSync(to, "COPIED CONTENT");
      NodeFS.writeFileSync(backup, "ORIGINAL CONTENT");
      const record: DestinationRecord = {
        version: 1,
        operationId,
        sourceUrl: "https://source.example.ts.net",
        token: "synthetic-fixture",
        sourceEnvironmentId: "source",
        sourceProjectId: "project",
        sourceMachine: "Source",
        mode: "copy-only",
        targetFolder: target,
        title: "Fixture",
        selection: [],
        decisions: {},
        clone: [],
        mirror: false,
        state: "applied",
        failedStep: null,
        error: null,
        progress: null,
        disk: null,
        checks: [],
        warnings: [],
        unstable: [],
        committed,
        projectId: null,
        requestedProjectId: null,
        createdAt: clock.toISOString(),
        updatedAt: clock.toISOString(),
      };
      NodeFS.writeFileSync(NodePath.join(operation, "operation.json"), JSON.stringify(record));
      const log = new JsonLog<JournalEntry>(journal);
      await log.append({ t: "backup", path: "report", backup }, true);
      await log.append(
        {
          t: "write",
          path: "report",
          sha256: NodeCrypto.createHash("sha256").update("COPIED CONTENT").digest("hex"),
          linkTarget: null,
        },
        true,
      );
      await log.append({ t: "write-done", path: "report" }, true);
      await log.close();

      const readdir = vi
        .spyOn(NodeFSP, "readdir")
        .mockRejectedValueOnce(
          Object.assign(new Error("EACCES: cannot list partials"), { code: "EACCES" }),
        );
      let failed;
      try {
        failed = await first.undo(operationId, false);
      } finally {
        readdir.mockRestore();
      }
      expect(failed.record).toMatchObject({ state: "failed", error: { code: "copy_failed" } });
      expect(failed.record.error?.message).toContain("EACCES");
      const wire = undoResult(copyStatus(failed.record, null), failed.preview, failed.result);
      expect(wire.undone).toBe(false);
      expect(wire.problems).toEqual(["report: EACCES: cannot list partials"]);
      expect(NodeFS.readFileSync(to, "utf8")).toBe("COPIED CONTENT");
      expect(NodeFS.readFileSync(backup, "utf8")).toBe("ORIGINAL CONTENT");
      expect(releases).toBe(0);

      // The marker is persisted; neither a reload nor normal retention may lose the original.
      await first.close();
      second = copies();
      clock = new Date(clock.getTime() + 15 * 24 * 60 * 60 * 1000);
      expect(await second.discardExpiredBackups()).toEqual([]);
      expect(NodeFS.readFileSync(backup, "utf8")).toBe("ORIGINAL CONTENT");
      await expect(second.retry(operationId)).rejects.toThrow(/Undo/);
      const recovered = await second.undo(operationId, false);
      expect(recovered.record).toMatchObject({ state: "undone", error: null });
      expect(recovered.result?.problems).toEqual([]);
      expect(
        undoResult(copyStatus(recovered.record, null), recovered.preview, recovered.result).undone,
      ).toBe(true);
      expect(NodeFS.readFileSync(to, "utf8")).toBe("ORIGINAL CONTENT");
      expect(releases).toBe(committed ? 0 : 1);
    } finally {
      await first.close();
      await second?.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

async function interruptedUndoFixture(
  state: "applied" | "applying",
  marked = true,
  overrides: Partial<DestinationRecord> = {},
  sourceFetch?: (action: string) => Promise<Response>,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-undo-startup-"));
  const operationId = NodeCrypto.randomUUID();
  const target = NodePath.join(root, "target");
  const stateRoot = NodePath.join(root, "state");
  const operation = NodePath.join(stateRoot, "folder-copies", operationId);
  const backup = NodePath.join(operation, "backups", "files", "report");
  const journal = NodePath.join(operation, "journal.ndjson");
  NodeFS.mkdirSync(target, { recursive: true });
  NodeFS.mkdirSync(NodePath.dirname(backup), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(target, "report"), "COPIED CONTENT");
  NodeFS.writeFileSync(backup, "ORIGINAL CONTENT");
  const record: DestinationRecord = {
    version: 1,
    operationId,
    sourceUrl: "https://source.example.ts.net",
    token: "fixture",
    sourceEnvironmentId: "source",
    sourceProjectId: "project",
    sourceMachine: "Source",
    mode: "copy-only",
    targetFolder: target,
    title: "Fixture",
    selection: [],
    decisions: {},
    clone: [],
    mirror: false,
    state,
    failedStep: null,
    error: null,
    progress: null,
    disk: null,
    checks: [],
    warnings: [],
    unstable: [],
    committed: false,
    projectId: null,
    requestedProjectId: null,
    undoIncomplete: marked,
    secretsDone: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  NodeFS.writeFileSync(NodePath.join(operation, "operation.json"), JSON.stringify(record));
  const log = new JsonLog<JournalEntry>(journal);
  await log.append({ t: "backup", path: "report", backup }, true);
  await log.append(
    {
      t: "write",
      path: "report",
      sha256: NodeCrypto.createHash("sha256").update("COPIED CONTENT").digest("hex"),
      linkTarget: null,
    },
    true,
  );
  await log.append({ t: "write-done", path: "report" }, true);
  await log.close();
  const { writeManifest, emptyTotals } = await import("./manifest.ts");
  await writeManifest(NodePath.join(operation, "manifest.ndjson.gz"), {
    header: {
      version: 1,
      operationId,
      chunkSize: 8 * 1024 * 1024,
      selection: [],
      repositories: [],
      totals: emptyTotals(),
      warnings: [],
      entryCount: 0,
    },
    entries: [],
  });
  const events: string[] = [];
  let releaseGate: Promise<void> = Promise.resolve();
  let releaseEntered = () => {};
  const copies = new DestinationCopies(stateRoot, {
    sleep: async () => {},
    fetch: async (url) => {
      const action = String(url).split("/").at(-1)!;
      events.push(action);
      if (sourceFetch) return sourceFetch(action);
      if (action === "release") {
        releaseEntered();
        await releaseGate;
      }
      return Response.json({
        environmentId: "source",
        operationId,
        state: action === "commit" ? "committed" : "ready",
      });
    },
    register: async () => {
      events.push("register");
      return "registered";
    },
  });
  return {
    root,
    operationId,
    target,
    copies,
    events,
    holdRelease: (gate: Promise<void>, entered: () => void) => {
      releaseGate = gate;
      releaseEntered = entered;
    },
  };
}

it.each(["applied", "applying"] as const)(
  "fences interrupted Undo before startup dispatch from %s",
  async (state) => {
    const fixture = await interruptedUndoFixture(state);
    const apply = vi.spyOn(
      fixture.copies as unknown as { apply: (...args: unknown[]) => Promise<void> },
      "apply",
    );
    try {
      await fixture.copies.resume();
      await fixture.copies.waitFor(fixture.operationId);
      expect(fixture.events).not.toContain("commit");
      expect(fixture.events).not.toContain("register");
      expect(apply).not.toHaveBeenCalled();
      expect(await fixture.copies.read(fixture.operationId)).toMatchObject({
        state: "failed",
        undoIncomplete: true,
      });
      const undone = await fixture.copies.undo(fixture.operationId, false);
      expect(undone.result?.problems).toEqual([]);
      expect(NodeFS.readFileSync(NodePath.join(fixture.target, "report"), "utf8")).toBe(
        "ORIGINAL CONTENT",
      );
    } finally {
      apply.mockRestore();
      await fixture.copies.close();
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

it("startup respects a foreground Undo paused after restoring files", async () => {
  const fixture = await interruptedUndoFixture("applied", false);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  fixture.holdRelease(gate, entered);
  const undo = fixture.copies.undo(fixture.operationId, false);
  try {
    await waiting;
    expect(NodeFS.readFileSync(NodePath.join(fixture.target, "report"), "utf8")).toBe(
      "ORIGINAL CONTENT",
    );
    await fixture.copies.resume();
    await fixture.copies.waitFor(fixture.operationId);
    expect(fixture.events).not.toContain("commit");
    expect(fixture.events).not.toContain("register");
  } finally {
    release();
    await undo;
    await fixture.copies.close();
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function pause() {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return { release, entered, gate, waiting };
}

it("expiry owns the operation through deletion and its record update before Undo can start", async () => {
  const fixture = await interruptedUndoFixture("applied", false, {
    committed: true,
    updatedAt: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const files = NodePath.join(
    fixture.root,
    "state",
    "folder-copies",
    fixture.operationId,
    "backups",
    "files",
  );
  const deleting = pause();
  const updating = pause();
  const originalRm = NodeFSP.rm;
  const rm = vi.spyOn(NodeFSP, "rm").mockImplementation(async (path, options) => {
    if (path === files) {
      deleting.entered();
      await deleting.gate;
    }
    return originalRm(path, options);
  });
  const service = fixture.copies as unknown as {
    update: (op: string, patch: Partial<DestinationRecord>) => Promise<DestinationRecord>;
  };
  const originalUpdate = service.update.bind(service);
  const update = vi.spyOn(service, "update").mockImplementation(async (op, patch) => {
    if (patch.backupsDiscardedAt) {
      updating.entered();
      await updating.gate;
    }
    return originalUpdate(op, patch);
  });
  const expiring = fixture.copies.discardExpiredBackups();
  try {
    await deleting.waiting;
    await expect(fixture.copies.undo(fixture.operationId, false)).rejects.toMatchObject({
      code: "busy",
    });
    expect(await fixture.copies.discardExpiredBackups()).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(files, "report"), "utf8")).toBe("ORIGINAL CONTENT");
    deleting.release();
    await updating.waiting;
    await expect(fixture.copies.undo(fixture.operationId, false)).rejects.toMatchObject({
      code: "busy",
    });
    updating.release();
    expect(await expiring).toEqual([fixture.operationId]);
    await expect(fixture.copies.undo(fixture.operationId, false)).rejects.toMatchObject({
      code: "refused",
    });
    expect(NodeFS.readFileSync(NodePath.join(fixture.target, "report"), "utf8")).toBe(
      "COPIED CONTENT",
    );
  } finally {
    deleting.release();
    updating.release();
    await expiring;
    update.mockRestore();
    rm.mockRestore();
    await fixture.copies.close();
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("Undo ownership prevents expiry after the recovery marker and restoration intent are synced", async () => {
  const fixture = await interruptedUndoFixture("applied", false, {
    committed: true,
    updatedAt: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const to = NodePath.join(fixture.target, "report");
  const op = NodePath.join(fixture.root, "state", "folder-copies", fixture.operationId);
  const removing = pause();
  const originalRm = NodeFSP.rm;
  const rm = vi.spyOn(NodeFSP, "rm").mockImplementation(async (path, options) => {
    if (path === to) {
      removing.entered();
      await removing.gate;
    }
    return originalRm(path, options);
  });
  const undoing = fixture.copies.undo(fixture.operationId, false);
  try {
    await removing.waiting;
    expect(await fixture.copies.read(fixture.operationId)).toMatchObject({ undoIncomplete: true });
    expect(NodeFS.readFileSync(NodePath.join(op, "journal.ndjson"), "utf8")).toContain(
      '"t":"undo-file-intent"',
    );
    expect(await fixture.copies.discardExpiredBackups()).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(op, "backups", "files", "report"), "utf8")).toBe(
      "ORIGINAL CONTENT",
    );
    removing.release();
    const undone = await undoing;
    expect(undone.result?.problems).toEqual([]);
    expect(undone.record).toMatchObject({ state: "undone", undoIncomplete: false });
    expect(NodeFS.readFileSync(to, "utf8")).toBe("ORIGINAL CONTENT");
  } finally {
    removing.release();
    await undoing;
    rm.mockRestore();
    await fixture.copies.close();
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("expiry rereads eligibility instead of deleting from an old list snapshot", async () => {
  const fixture = await interruptedUndoFixture("applied", false, {
    committed: true,
    updatedAt: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const recordFile = NodePath.join(
    fixture.root,
    "state",
    "folder-copies",
    fixture.operationId,
    "operation.json",
  );
  const originalList = fixture.copies.list.bind(fixture.copies);
  const list = vi.spyOn(fixture.copies, "list").mockImplementationOnce(async () => {
    const stale = await originalList();
    NodeFS.writeFileSync(recordFile, JSON.stringify({ ...stale[0], undoIncomplete: true }));
    return stale;
  });
  try {
    expect(await fixture.copies.discardExpiredBackups()).toEqual([]);
    expect(
      NodeFS.readFileSync(
        NodePath.join(NodePath.dirname(recordFile), "backups", "files", "report"),
        "utf8",
      ),
    ).toBe("ORIGINAL CONTENT");
  } finally {
    list.mockRestore();
    await fixture.copies.close();
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("expiry releases its ownership after a deletion error so Undo can recover", async () => {
  const fixture = await interruptedUndoFixture("applied", false, {
    committed: true,
    updatedAt: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const rm = vi
    .spyOn(NodeFSP, "rm")
    .mockRejectedValueOnce(new Error("EACCES: backup deletion refused"));
  try {
    await expect(fixture.copies.discardExpiredBackups()).rejects.toThrow("EACCES");
    rm.mockRestore();
    const undone = await fixture.copies.undo(fixture.operationId, false);
    expect(undone.result?.problems).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(fixture.target, "report"), "utf8")).toBe(
      "ORIGINAL CONTENT",
    );
  } finally {
    rm.mockRestore();
    await fixture.copies.close();
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("finishes partial Undo instead of registering mixed files after a lost source commit reply", async () => {
  let reachable = false;
  const fixture = await interruptedUndoFixture(
    "applied",
    false,
    {
      state: "failed",
      failedStep: "applied",
      committed: false,
      mode: "copy-and-move",
      error: { code: "unreachable", message: "The source stopped answering after commit." },
    },
    async (action) => {
      if (action === "hello") {
        if (!reachable) throw new TypeError("source unreachable after lost commit reply");
        return Response.json({
          environmentId: "source",
          operationId: fixture.operationId,
          state: "committed",
        });
      }
      throw new Error(`Committed source refuses ${action}`);
    },
  );
  const operation = NodePath.join(fixture.root, "state", "folder-copies", fixture.operationId);
  const healthy = NodePath.join(fixture.target, "healthy", "report");
  const backup = NodePath.join(operation, "backups", "files", "healthy", "report");
  NodeFS.mkdirSync(NodePath.dirname(healthy), { recursive: true });
  NodeFS.mkdirSync(NodePath.dirname(backup), { recursive: true });
  NodeFS.writeFileSync(healthy, "COPIED HEALTHY");
  NodeFS.writeFileSync(backup, "ORIGINAL HEALTHY");
  const log = new JsonLog<JournalEntry>(NodePath.join(operation, "journal.ndjson"));
  await log.append({ t: "backup", path: "healthy/report", backup }, true);
  await log.append(
    {
      t: "write",
      path: "healthy/report",
      sha256: NodeCrypto.createHash("sha256").update("COPIED HEALTHY").digest("hex"),
      linkTarget: null,
    },
    true,
  );
  await log.append({ t: "write-done", path: "healthy/report" }, true);
  await log.close();
  const originalReaddir = NodeFSP.readdir;
  const readdir = vi.spyOn(NodeFSP, "readdir").mockImplementation(((
    path: unknown,
    options: unknown,
  ) => {
    if (path === fixture.target)
      return Promise.reject(Object.assign(new Error("EACCES: blocked report"), { code: "EACCES" }));
    return originalReaddir(path as string, options as never);
  }) as typeof NodeFSP.readdir);
  try {
    const first = await fixture.copies.undo(fixture.operationId, false);
    expect(first.record).toMatchObject({ state: "failed", undoIncomplete: true });
    expect(first.result?.restored).toBe(1);
    expect(first.result?.problems).toHaveLength(1);
    expect(NodeFS.readFileSync(healthy, "utf8")).toBe("ORIGINAL HEALTHY");
    expect(NodeFS.readFileSync(NodePath.join(fixture.target, "report"), "utf8")).toBe(
      "COPIED CONTENT",
    );
    readdir.mockRestore();
    await expect(fixture.copies.retry(fixture.operationId)).rejects.toThrow(/Undo/);
    expect(fixture.events).not.toContain("register");
    expect(fixture.events).not.toContain("commit");
    reachable = true;
    const recovered = await fixture.copies.undo(fixture.operationId, false);
    await fixture.copies.waitFor(fixture.operationId);
    expect(recovered.record).toMatchObject({
      state: "undone",
      undoIncomplete: false,
      projectId: null,
    });
    expect(recovered.result?.problems).toEqual([]);
    expect(recovered.record.error).not.toBeNull(); // Source hold refusal is still visible.
    expect(NodeFS.readFileSync(healthy, "utf8")).toBe("ORIGINAL HEALTHY");
    expect(NodeFS.readFileSync(NodePath.join(fixture.target, "report"), "utf8")).toBe(
      "ORIGINAL CONTENT",
    );
    expect(fixture.events).not.toContain("register");
    expect(fixture.events).not.toContain("commit");
  } finally {
    readdir.mockRestore();
    await fixture.copies.close();
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
}, 30_000);

it("still refuses a fresh Undo when the source confirms this move already committed", async () => {
  const fixture = await interruptedUndoFixture(
    "applied",
    false,
    { mode: "copy-and-move" },
    async () =>
      Response.json({
        environmentId: "source",
        operationId: fixture.operationId,
        state: "committed",
      }),
  );
  try {
    await expect(fixture.copies.undo(fixture.operationId, false)).rejects.toMatchObject({
      code: "refused",
    });
    await fixture.copies.waitFor(fixture.operationId);
    expect(await fixture.copies.read(fixture.operationId)).toMatchObject({
      state: "applied",
      committed: true,
      projectId: "registered",
      undoIncomplete: false,
    });
    expect(NodeFS.readFileSync(NodePath.join(fixture.target, "report"), "utf8")).toBe(
      "COPIED CONTENT",
    );
    expect(fixture.events.filter((action) => action === "register")).toHaveLength(1);
  } finally {
    await fixture.copies.close();
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("claims Retry before an actual delayed record read so Undo cannot invalidate its eligibility", async () => {
  const fixture = await interruptedUndoFixture("applied", false, {
    state: "failed",
    failedStep: "applied",
    error: { code: "unreachable", message: "Commit reply lost" },
  });
  const recordFile = NodePath.join(
    fixture.root,
    "state",
    "folder-copies",
    fixture.operationId,
    "operation.json",
  );
  const reading = pause();
  const originalReadFile = NodeFSP.readFile;
  let first = true;
  const read = vi.spyOn(NodeFSP, "readFile").mockImplementation((async (
    path: unknown,
    options: unknown,
  ) => {
    const result = await originalReadFile(path as string, options as never);
    if (path === recordFile && first) {
      first = false;
      reading.entered();
      await reading.gate;
    }
    return result;
  }) as typeof NodeFSP.readFile);
  const retrying = fixture.copies.retry(fixture.operationId);
  try {
    await reading.waiting;
    await expect(fixture.copies.undo(fixture.operationId, false)).rejects.toMatchObject({
      code: "busy",
    });
    expect(NodeFS.readFileSync(NodePath.join(fixture.target, "report"), "utf8")).toBe(
      "COPIED CONTENT",
    );
    reading.release();
    await retrying;
    await fixture.copies.waitFor(fixture.operationId);
    expect(await fixture.copies.read(fixture.operationId)).toMatchObject({
      state: "applied",
      undoIncomplete: false,
    });
    expect(NodeFS.readFileSync(NodePath.join(fixture.target, "report"), "utf8")).toBe(
      "COPIED CONTENT",
    );
  } finally {
    reading.release();
    await retrying;
    await fixture.copies.waitFor(fixture.operationId);
    read.mockRestore();
    await fixture.copies.close();
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});
