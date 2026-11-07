// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FileFinder } from "@ff-labs/fff-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as NodeWorkerThreads from "node:worker_threads";

import {
  SEARCH_FINDER_WORKER_SOURCE,
  SearchFinderLostError,
  SearchFinderWorkerHost,
} from "./WorkspaceSearchFinder.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A stand-in for fff whose `mixedSearch` and `destroy` block the worker
 * thread for good, the way fff_destroy waited on a lock held by a watcher
 * stuck in a DeviceFS read.
 */
const HANGING_WORKER = `
const { parentPort } = require("node:worker_threads");
parentPort.postMessage({ type: "ready" });
parentPort.on("message", ({ id, op }) => {
  if (op === "shutdown") process.exit(0);
  parentPort.postMessage({ type: "start", id });
  if (op === "mixedSearch" || op === "destroy") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  const value = op === "create" ? { ok: true, value: id } : op === "isScanning" ? false : { ok: true, value: true };
  parentPort.postMessage({ type: "reply", id, ok: true, value });
});
`;

/** How long BLOCKING_WORKER's `mixedSearch` blocks its thread. */
const BLOCKING_CALL_MS = 2_500;

/**
 * A stand-in for a native call that termination cannot interrupt: a
 * synchronous child process blocks the worker thread until it ends.
 */
const BLOCKING_WORKER = `
const { parentPort } = require("node:worker_threads");
const { execFileSync } = require("node:child_process");
parentPort.postMessage({ type: "ready" });
parentPort.on("message", ({ id, op }) => {
  if (op === "shutdown") process.exit(0);
  parentPort.postMessage({ type: "start", id });
  if (op === "mixedSearch") {
    execFileSync(process.execPath, ["-e", "setTimeout(() => {}, ${BLOCKING_CALL_MS})"]);
  }
  const value = op === "create" ? { ok: true, value: id } : op === "isScanning" ? false : { ok: true, value: true };
  parentPort.postMessage({ type: "reply", id, ok: true, value });
});
`;

const ERRORING_WORKER = `
const { parentPort } = require("node:worker_threads");
parentPort.postMessage({ type: "ready" });
parentPort.on("message", ({ id, op }) => {
  if (op === "shutdown") process.exit(0);
  parentPort.postMessage({ type: "start", id });
  const value =
    op === "create" ? { ok: true, value: id }
    : op === "grep" ? { ok: false, error: "bad regex" }
    : op === "isScanning" ? false
    : undefined;
  parentPort.postMessage({ type: "reply", id, ok: true, value });
});
`;

/** How long SLOW_WORKER's `grep` blocks its thread: slow, but within the deadline. */
const SLOW_CALL_MS = 400;

/** Every `grep` blocks the thread for SLOW_CALL_MS, so concurrent ones queue. */
const SLOW_WORKER = `
const { parentPort } = require("node:worker_threads");
parentPort.postMessage({ type: "ready" });
parentPort.on("message", ({ id, op }) => {
  if (op === "shutdown") process.exit(0);
  parentPort.postMessage({ type: "start", id });
  if (op === "grep") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SLOW_CALL_MS});
  const value = op === "create" ? { ok: true, value: id } : op === "isScanning" ? false : { ok: true, value: true };
  parentPort.postMessage({ type: "reply", id, ok: true, value });
});
`;

/**
 * Its \`mixedSearch\` blocks for a while and then returns; on shutdown it
 * records which finders it destroyed, the way the real worker destroys them.
 */
const draining = (logPath: string) => `
const { parentPort } = require("node:worker_threads");
const { writeFileSync } = require("node:fs");
const finders = new Set();
parentPort.postMessage({ type: "ready" });
parentPort.on("message", ({ id, op, handle }) => {
  if (op === "shutdown") {
    writeFileSync(${JSON.stringify(logPath)}, JSON.stringify([...finders]));
    process.exit(0);
  }
  parentPort.postMessage({ type: "start", id });
  if (op === "create") finders.add(id);
  if (op === "mixedSearch") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  const value = op === "create" ? { ok: true, value: id } : op === "isScanning" ? false : { ok: true, value: true };
  parentPort.postMessage({ type: "reply", id, ok: true, value });
});
`;

const LOAD_FAILING_WORKER = `
const { parentPort } = require("node:worker_threads");
parentPort.postMessage({ type: "loadFailed", error: "native library unavailable" });
`;

/** Counts event loop turns while `promise` runs, to show the loop never stalls. */
async function ticksWhile<A>(
  promise: Promise<A>,
): Promise<{ result: PromiseSettledResult<A>; ticks: number }> {
  let ticks = 0;
  const interval = setInterval(() => {
    ticks += 1;
  }, 10);
  const [result] = await Promise.allSettled([promise]);
  clearInterval(interval);
  return { result: result!, ticks };
}

describe("SearchFinderWorkerHost", () => {
  it("runs fff in the worker thread", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "search-finder-"));
    try {
      await NodeFSP.mkdir(NodePath.join(root, "src"));
      await NodeFSP.writeFile(
        NodePath.join(root, "src", "needle.ts"),
        "export const needle = 1;\n",
      );
      const create = vi.spyOn(FileFinder, "create");
      const host = new SearchFinderWorkerHost();

      const created = await host.create({
        basePath: root,
        disableMmapCache: true,
        disableContentIndexing: true,
        aiMode: false,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const finder = created.value;
      await expect(finder.waitForIndexReady(10_000)).resolves.toEqual({ ok: true, value: true });
      const result = await finder.fileSearch("needle", { pageSize: 5 });
      expect(result.ok && result.value.items.map((item) => item.relativePath)).toEqual([
        NodePath.join("src", "needle.ts"),
      ]);
      // fff ran in the worker, never through this thread's module.
      expect(create).not.toHaveBeenCalled();
      expect(finder.destroy()).toBeUndefined();
      expect(host.unavailableReason).toBeUndefined();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses the home folder in fff itself", async () => {
    const host = new SearchFinderWorkerHost();
    const created = await host.create({
      basePath: NodeOS.homedir(),
      enableFsRootScanning: false,
      enableHomeDirScanning: false,
    });
    expect(created.ok).toBe(false);
  });

  it("runs every index in one shared worker that outlives destroy", async () => {
    const roots = await Promise.all(
      ["a", "b"].map(async (name) => {
        const root = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), `search-finder-${name}-`),
        );
        await NodeFSP.writeFile(NodePath.join(root, `${name}-needle.ts`), "export {};\n");
        return root;
      }),
    );
    try {
      const host = new SearchFinderWorkerHost();
      const finders = await Promise.all(
        roots.map(async (root) => {
          const created = await host.create({ basePath: root, disableContentIndexing: true });
          if (!created.ok) throw new Error(created.error);
          return created.value;
        }),
      );
      expect(host.workerCount).toBe(1);
      expect(host.spawnCount).toBe(1);
      expect(host.openIndexCount).toBe(2);
      for (const [index, name] of ["a", "b"].entries()) {
        const finder = finders[index]!;
        await finder.waitForIndexReady(10_000);
        const result = await finder.fileSearch("needle", { pageSize: 5 });
        expect(result.ok && result.value.items.map((item) => item.relativePath)).toEqual([
          `${name}-needle.ts`,
        ]);
      }

      finders[0]!.destroy();
      await expect(finders[0]!.isScanning()).rejects.toBeInstanceOf(SearchFinderLostError);
      await expect(finders[1]!.isScanning()).resolves.toBe(false);
      expect(host.openIndexCount).toBe(1);
      finders[1]!.destroy();
      expect(host.openIndexCount).toBe(0);
      expect(host.workerCount).toBe(1);
    } finally {
      await Promise.all(roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true })));
    }
  });

  // ffi-rs keeps one unlocked process-wide symbol map, so fff called from
  // several worker threads at once crashed the process (SIGSEGV on Linux CI).
  // A crash here kills the test process, not just this test.
  it("creates, searches and destroys many indexes at once without crashing", async () => {
    const roots = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "search-finder-many-"));
        for (let dir = 0; dir < 5; dir += 1) {
          await NodeFSP.mkdir(NodePath.join(root, `dir-${dir}`));
          for (let file = 0; file < 10; file += 1) {
            await NodeFSP.writeFile(
              NodePath.join(root, `dir-${dir}`, `file-${index}-${file}.ts`),
              "export {};\n",
            );
          }
        }
        return root;
      }),
    );
    try {
      for (let round = 0; round < 3; round += 1) {
        const host = new SearchFinderWorkerHost();
        await Promise.all(
          roots.map(async (root, index) => {
            const created = await host.create({ basePath: root, disableContentIndexing: true });
            if (!created.ok) throw new Error(created.error);
            const finder = created.value;
            await finder.waitForIndexReady(10_000);
            for (let search = 0; search < 10; search += 1) {
              const result = await finder.fileSearch(`file-${index}`, { pageSize: 5 });
              expect(result.ok).toBe(true);
              await finder.directorySearch("dir", { pageSize: 5 });
              await finder.mixedSearch("dir-1", { pageSize: 5 });
            }
            finder.destroy();
          }),
        );
        expect(host.spawnCount).toBe(1);
      }
    } finally {
      await Promise.all(roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true })));
    }
  });

  it("reports an fff error as a result, not as a lost worker", async () => {
    const host = new SearchFinderWorkerHost({ workerSource: ERRORING_WORKER });
    const created = await host.create({ basePath: "/workspace/project" });
    if (!created.ok) throw new Error(created.error);
    await expect(created.value.grep("(", {})).resolves.toEqual({ ok: false, error: "bad regex" });
    await expect(created.value.isScanning()).resolves.toBe(false);
    created.value.destroy();
  });

  it("retires the worker when a call hangs, without blocking the event loop", async () => {
    const host = new SearchFinderWorkerHost({
      callTimeoutMs: 300,
      retiredWorkerGraceMs: 300,
      workerSource: HANGING_WORKER,
    });
    const created = await host.create({ basePath: "/workspace/project" });
    const other = await host.create({ basePath: "/workspace/other" });
    if (!created.ok || !other.ok) throw new Error("expected finders");

    const { result, ticks } = await ticksWhile(created.value.mixedSearch("", { pageSize: 10 }));
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.reason).toBeInstanceOf(SearchFinderLostError);
    expect(result.status === "rejected" && String(result.reason)).toMatch(
      /did not answer 'mixedSearch' within 300 ms/,
    );
    // The loop kept turning the whole time the worker was stuck.
    expect(ticks).toBeGreaterThan(5);
    await expect(created.value.isScanning()).rejects.toBeInstanceOf(SearchFinderLostError);
    // Indexes share the worker, so the other one is lost too and rebuilds.
    await expect(other.value.isScanning()).rejects.toBeInstanceOf(SearchFinderLostError);
    expect(host.workerCount).toBe(0);

    const fresh = await host.create({ basePath: "/workspace/project" });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) await expect(fresh.value.isScanning()).resolves.toBe(false);
    expect(host.spawnCount).toBe(2);
  });

  it("returns from destroy at once and stops the worker at the deadline when destroy hangs", async () => {
    const host = new SearchFinderWorkerHost({ callTimeoutMs: 300, workerSource: HANGING_WORKER });
    const created = await host.create({ basePath: "/workspace/project" });
    const other = await host.create({ basePath: "/workspace/other" });
    if (!created.ok || !other.ok) throw new Error("expected finders");

    const started = performance.now();
    created.value.destroy();
    expect(performance.now() - started).toBeLessThan(50);
    await expect(created.value.isScanning()).rejects.toBeInstanceOf(SearchFinderLostError);

    const { result, ticks } = await ticksWhile(
      vi.waitFor(() => expect(host.workerCount).toBe(0), { timeout: 2_000 }),
    );
    expect(result.status).toBe("fulfilled");
    expect(ticks).toBeGreaterThan(5);
    await expect(other.value.isScanning()).rejects.toBeInstanceOf(SearchFinderLostError);
  });

  it("starts a replacement worker only once the retired one has exited", async () => {
    const host = new SearchFinderWorkerHost({
      callTimeoutMs: 200,
      retiredWorkerGraceMs: 60_000,
      workerSource: BLOCKING_WORKER,
    });
    const created = await host.create({ basePath: "/workspace/project" });
    if (!created.ok) throw new Error(created.error);
    const started = performance.now();
    await expect(created.value.mixedSearch("", { pageSize: 10 })).rejects.toBeInstanceOf(
      SearchFinderLostError,
    );
    // terminate() cannot interrupt the blocking call, so the replacement
    // waits until it returns and the old worker exits.
    const fresh = await host.create({ basePath: "/workspace/project" });
    expect(fresh.ok).toBe(true);
    expect(performance.now() - started).toBeGreaterThan(BLOCKING_CALL_MS - 200);
    expect(host.spawnCount).toBe(2);
  });

  it("starts a replacement worker after the grace period while the retired one stays blocked", async () => {
    const host = new SearchFinderWorkerHost({
      callTimeoutMs: 200,
      retiredWorkerGraceMs: 300,
      workerSource: BLOCKING_WORKER,
    });
    const created = await host.create({ basePath: "/workspace/project" });
    if (!created.ok) throw new Error(created.error);
    const started = performance.now();
    await expect(created.value.mixedSearch("", { pageSize: 10 })).rejects.toBeInstanceOf(
      SearchFinderLostError,
    );
    const fresh = await host.create({ basePath: "/workspace/project" });
    expect(fresh.ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(BLOCKING_CALL_MS - 500);
  });

  it("does not count time queued behind other indexes' calls against the deadline", async () => {
    const host = new SearchFinderWorkerHost({ callTimeoutMs: 700, workerSource: SLOW_WORKER });
    const finders = await Promise.all(
      ["a", "b", "c", "d"].map(async (name) => {
        const created = await host.create({ basePath: `/workspace/${name}` });
        if (!created.ok) throw new Error(created.error);
        return created.value;
      }),
    );
    const started = performance.now();
    // Each call takes SLOW_CALL_MS of the deadline; the last one is answered
    // well after the deadline would have passed had its queue time counted.
    const results = await Promise.all(finders.map((finder) => finder.grep("x", {})));
    expect(performance.now() - started).toBeGreaterThan(4 * SLOW_CALL_MS - 100);
    expect(results).toEqual(finders.map(() => ({ ok: true, value: true })));
    expect(host.spawnCount).toBe(1);
    expect(host.workerCount).toBe(1);
  });

  it("has the retired worker destroy every index before the replacement starts", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "search-finder-drain-"));
    try {
      const log = NodePath.join(dir, "destroyed.json");
      const host = new SearchFinderWorkerHost({
        callTimeoutMs: 200,
        retiredWorkerGraceMs: 60_000,
        workerSource: draining(log),
      });
      const first = await host.create({ basePath: "/workspace/a" });
      const second = await host.create({ basePath: "/workspace/b" });
      if (!first.ok || !second.ok) throw new Error("expected finders");
      await expect(first.value.mixedSearch("", { pageSize: 10 })).rejects.toBeInstanceOf(
        SearchFinderLostError,
      );
      const fresh = await host.create({ basePath: "/workspace/a" });
      expect(fresh.ok).toBe(true);
      expect(host.spawnCount).toBe(2);
      // Both indexes, not only the stuck one, were destroyed before it exited.
      expect(JSON.parse(await NodeFSP.readFile(log, "utf8"))).toHaveLength(2);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("destroys the real fff finders and exits when asked to shut down", async () => {
    const roots = await Promise.all(
      ["a", "b"].map((name) =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), `search-finder-shutdown-${name}-`)),
      ),
    );
    const worker = new NodeWorkerThreads.Worker(SEARCH_FINDER_WORKER_SOURCE, {
      eval: true,
      workerData: { requireFrom: new URL("./WorkspaceSearchFinder.ts", import.meta.url).href },
    });
    try {
      const replies = new Map<number, { ok: boolean; value?: { ok: boolean } }>();
      const messages: Array<{ type: string }> = [];
      worker.on("message", (message: { type: string; id: number; ok: boolean }) => {
        messages.push(message);
        if (message.type === "reply") replies.set(message.id, message);
      });
      const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
      for (const [index, root] of roots.entries()) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        worker.postMessage({ id: index + 1, op: "create", args: [{ basePath: root }] });
      }
      await vi.waitFor(() => expect(replies.size).toBe(2), { timeout: 5_000 });
      expect([...replies.values()].every((reply) => reply.ok && reply.value?.ok)).toBe(true);
      expect(messages.filter((message) => message.type === "start")).toHaveLength(2);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage({ op: "shutdown" });
      await expect(exited).resolves.toBe(0);
    } finally {
      await worker.terminate();
      await Promise.all(roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true })));
    }
  });

  it("fails index creation, never runs fff in-process, and retries after a while when fff cannot load", async () => {
    const create = vi.spyOn(FileFinder, "create");
    const host = new SearchFinderWorkerHost({
      workerSource: LOAD_FAILING_WORKER,
      loadRetryMs: 200,
    });

    const first = await host.create({ basePath: "/workspace/project" });
    expect(first).toEqual({
      ok: false,
      error: "Workspace search is unavailable: native library unavailable",
    });
    expect(host.unavailableReason).toBe("native library unavailable");
    expect(host.workerCount).toBe(0);
    // Within the retry window no new worker is spawned.
    expect(host.spawnCount).toBe(1);
    expect((await host.create({ basePath: "/workspace/project" })).ok).toBe(false);
    expect(host.spawnCount).toBe(1);
    expect(create).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(host.unavailableReason).toBeUndefined();
    expect((await host.create({ basePath: "/workspace/project" })).ok).toBe(false);
    expect(host.spawnCount).toBe(2);
    expect(create).not.toHaveBeenCalled();
  });
});
