// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - disposable real Git fixtures only.
/**
 * End-to-end folder copy between two isolated sides talking over loopback HTTP:
 * a source with its own state folder serving the transfer routes, and a
 * destination with its own state folder pulling from it. Run by
 * `node scripts/studio-folder-transfer/verify.mjs <report dir>`, which sets
 * FOLDER_TRANSFER_REPORT_DIR so each scenario writes its evidence there.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { folderCopyAllConflictsKey } from "@specweave-studio/contracts";

import { CopyError, DestinationCopies, type DestinationRecord } from "./destinationService.ts";
import { git, makeUmbrella, write, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import { readManifestFile } from "./manifest.ts";
import { stagedPath } from "./pullWorker.ts";
import { repoRowId } from "./reconcile.ts";
import { SourceTransfers, type SourceOperationRecord } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";

const reportDir = process.env.FOLDER_TRANSFER_REPORT_DIR;
const evidence: Record<string, unknown> = {};
const note = (scenario: string, value: unknown) => {
  evidence[scenario] = value;
};

let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
const released: Array<{ operationId: string; reason: string }> = [];

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-verify-")));
  fixture = makeUmbrella(NodePath.join(base, "source-machine"));
  transfers = new SourceTransfers(NodePath.join(base, "source-machine", "state"), {
    release: async (record: SourceOperationRecord, reason: string) => {
      released.push({ operationId: record.operationId, reason });
    },
  });
  served = await serveSource(transfers, "env-source");
}, 60_000);

afterAll(async () => {
  await served?.close();
  if (reportDir) {
    NodeFS.mkdirSync(reportDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(reportDir, "folder-transfer-verify.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }
  if (base) NodeFS.rmSync(base, { recursive: true, force: true });
});

const destinationState = (name: string) => NodePath.join(base, "destination-machine", name);
const target = (name: string) => NodePath.join(base, "destination-machine", "targets", name);

/** Counts chunk requests and lets a scenario drop or stall the network. */
function network(onChunks?: (count: number) => Promise<void> | void) {
  const seen = { chunks: 0 };
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/chunks")) {
      seen.chunks += 1;
      await onChunks?.(seen.chunks);
    }
    return fetch(input, init);
  };
  return { fetch: wrapped, seen };
}

const fast = { allowLoopback: true, sleep: async () => undefined, pollMs: 20 } as const;

async function settle(
  copies: DestinationCopies,
  operationId: string,
  until: ReadonlyArray<string>,
): Promise<DestinationRecord> {
  for (let attempt = 0; attempt < 1500; attempt += 1) {
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

const startInput = (
  operationId: string,
  token: string,
  targetFolder: string,
  mode: "copy-only" | "copy-and-move" = "copy-only",
) => ({
  operationId,
  sourceUrl: served.url,
  token,
  sourceEnvironmentId: "env-source",
  sourceProjectId: "project-source",
  sourceMachine: "M4MAX",
  mode,
  targetFolder,
  title: "Umbrella",
});

const REPOSITORIES = ["", "repositories/svc-a", "repositories/svc-b"] as const;

/** What must match between source and copy for one repository. */
function repositoryState(root: string, repository: string) {
  const directory = NodePath.join(root, repository);
  return {
    head: git(directory, "rev-parse", "HEAD"),
    branches: git(directory, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
    stashes: git(directory, "stash", "list", "--format=%H"),
    status: git(directory, "status", "--porcelain=v1", "--untracked-files=all"),
  };
}

/** Working files (not Git internals), refs and HEADs, for byte-for-byte comparisons. */
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const absolute = NodePath.join(directory, entry.name);
      const relative = NodePath.relative(root, absolute);
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink()) result[relative] = `link:${NodeFS.readlinkSync(absolute)}`;
      else if (entry.isDirectory()) walk(absolute);
      else
        result[relative] = NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(absolute))
          .digest("hex");
    }
  };
  walk(root);
  for (const repository of REPOSITORIES) {
    const directory = NodePath.join(root, repository);
    if (!NodeFS.existsSync(NodePath.join(directory, ".git"))) continue;
    result[`refs:${repository}`] = git(
      directory,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/stash",
    );
    result[`HEAD:${repository}`] = git(directory, "rev-parse", "HEAD");
  }
  return result;
}

describe("folder copy between two isolated sides", () => {
  it("copies into an empty folder through a restart and a dropped network", async () => {
    const operation = await offer();
    const folder = target("empty");
    const state = destinationState("restart");
    let first: DestinationCopies | null = null;
    let stopped = false;
    const firstNetwork = network(async (count) => {
      // Hold the third batch until the first two are written, then restart mid-transfer.
      if (count === 3 && !stopped) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        stopped = true;
        void first?.close();
      }
    });
    first = new DestinationCopies(state, { ...fast, fetch: firstNetwork.fetch });
    await first.start(startInput(operation.operationId, operation.token, folder));
    const previewed = await settle(first, operation.operationId, ["previewed", "failed"]);
    expect(previewed.error).toBeNull();
    expect(NodeFS.existsSync(folder)).toBe(false);
    await first.approve(operation.operationId);
    await first.waitFor(operation.operationId);
    const interrupted = await first.read(operation.operationId);
    expect(stopped).toBe(true);
    expect(["transferring", "verifying"]).toContain(interrupted?.state);
    expect(NodeFS.existsSync(folder)).toBe(false);
    const chunkRequestsBefore = served.requests.filter((r) => r.action === "chunks");
    // Files already verified in staging when the destination stopped.
    const operationDirectory = NodePath.join(state, "folder-copies", operation.operationId);
    const manifest = await readManifestFile(
      NodePath.join(operationDirectory, "manifest.ndjson.gz"),
    );
    const files = manifest.entries.filter((entry) => entry.type === "file" && entry.chunks);
    const staged = (path: string) => {
      try {
        return NodeFS.readFileSync(stagedPath(NodePath.join(operationDirectory, "staging"), path));
      } catch {
        return null;
      }
    };
    const complete = files.filter((entry) =>
      staged(entry.path)?.equals(NodeFS.readFileSync(NodePath.join(fixture.root, entry.path))),
    );
    expect(complete.length).toBeGreaterThan(0);
    expect(complete.length).toBeLessThan(files.length);
    const stillNeeded = new Set(
      files.filter((entry) => !complete.includes(entry)).flatMap((entry) => entry.chunks!),
    );
    const verifiedChunks = new Set(
      complete.flatMap((entry) => entry.chunks!).filter((sha) => !stillNeeded.has(sha)),
    );

    // The destination restarts; the network then drops twice before recovering.
    let dropped = 0;
    const secondNetwork = network((count) => {
      if (count <= 2) {
        dropped += 1;
        throw new TypeError("fetch failed");
      }
    });
    const second = new DestinationCopies(state, {
      ...fast,
      fetch: secondNetwork.fetch,
      register: async () => "project-copied",
    });
    await second.resume();
    const applied = await settle(second, operation.operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    expect(applied.checks.filter((check) => !check.ok)).toEqual([]);
    expect(applied.committed).toBe(true);
    expect(dropped).toBe(2);
    const secondRunChunks = new Set(
      served.requests
        .filter((r) => r.action === "chunks")
        .slice(chunkRequestsBefore.length)
        .flatMap((r) => JSON.parse(r.body).chunks as Array<string>),
    );
    const resent = [...verifiedChunks].filter((sha) => secondRunChunks.has(sha));
    expect(resent).toEqual([]);

    // AC-07: the copy works like the source.
    const matched: Record<string, boolean> = {};
    for (const repository of REPOSITORIES) {
      const copied = NodePath.join(folder, repository);
      git(copied, "fsck", "--connectivity-only");
      expect(repositoryState(folder, repository)).toEqual(
        repositoryState(fixture.root, repository),
      );
      matched[repository || "(umbrella)"] = true;
    }
    const worktree = NodePath.join(folder, "repositories/svc-a-wt-feature");
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(git(worktree, "status", "--porcelain")).toContain("src/a.ts");
    expect(
      NodeFS.lstatSync(NodePath.join(folder, ".cursor/skills/appstore")).isSymbolicLink(),
    ).toBe(true);
    expect(NodeFS.statSync(NodePath.join(folder, "scripts/run.sh")).mode & 0o777).toBe(0o755);
    expect(NodeFS.statSync(NodePath.join(folder, "work/big.bin")).size).toBe(fixture.bigFileBytes);
    expect(NodeFS.existsSync(NodePath.join(folder, ".env"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(folder, "node_modules"))).toBe(false);
    expect((await transfers.read(operation.operationId))?.state).toBe("committed");
    note("empty-folder-restart-and-drop", {
      state: applied.state,
      checks: applied.checks,
      firstRunChunkRequests: chunkRequestsBefore.length,
      networkDrops: dropped,
      filesVerifiedBeforeRestart: complete.length,
      filesTotal: files.length,
      verifiedChunksResentAfterRestart: resent.length,
      chunksPulledAfterRestart: secondRunChunks.size,
      matchedRepositories: matched,
      linkedWorktreeBranch: "feature",
      excluded: [".env", "node_modules"],
    });
    await second.close();
  }, 180_000);

  it("reconciles an out-of-sync folder, keeps both sides' work, and Undo restores it", async () => {
    const folder = target("existing");
    NodeFS.mkdirSync(NodePath.dirname(folder), { recursive: true });
    git(
      NodePath.dirname(folder),
      "clone",
      "-q",
      NodePath.join(fixture.origins, "umbrella.git"),
      folder,
    );
    // Both sides edit the same tracked file without committing.
    write(NodePath.join(folder, "docs/guide.md"), "guide edited on the destination\n");
    NodeFS.mkdirSync(NodePath.join(folder, "repositories"), { recursive: true });
    git(
      NodePath.join(folder, "repositories"),
      "clone",
      "-q",
      NodePath.join(fixture.origins, "svc-b.git"),
      "svc-b",
    );
    const serviceB = NodePath.join(folder, "repositories/svc-b");
    write(NodePath.join(serviceB, "src/dest-only.ts"), "destination commit\n");
    git(serviceB, "add", "-A");
    git(serviceB, "commit", "-q", "-m", "destination-only commit");
    const destinationHead = git(serviceB, "rev-parse", "HEAD");
    const sourceServiceB = NodePath.join(fixture.root, "repositories/svc-b");
    git(sourceServiceB, "commit", "-q", "--allow-empty", "-m", "source-only commit");
    const before = snapshot(folder);

    const copies = new DestinationCopies(destinationState("existing"), fast);
    const operation = await offer();
    await copies.start(startInput(operation.operationId, operation.token, folder));
    await settle(copies, operation.operationId, ["previewed"]);
    const plan = (await copies.readPlan(operation.operationId))!;
    const serviceRow = plan.rows.find((row) => row.id === repoRowId("repositories/svc-b"));
    expect(serviceRow?.status).toBe("diverged");
    expect(plan.totals.decisionsNeeded).toBeGreaterThan(0);
    const conflicted = plan.rows.filter((row) => row.conflicts.length > 0);
    expect(conflicted.length).toBeGreaterThan(0);
    await expect(copies.approve(operation.operationId)).rejects.toThrow(/decision/);
    const decisions = Object.fromEntries(
      plan.rows.flatMap((row) => [
        ...(row.needsDecision ? [[row.id, row.choices[0]!] as const] : []),
        ...(row.conflicts.some((conflict) => conflict.decision === null)
          ? [[folderCopyAllConflictsKey(row.id), "keep-mine" as const] as const]
          : []),
      ]),
    );
    await copies.decide(operation.operationId, { decisions });
    await settle(copies, operation.operationId, ["previewed"]);
    expect((await copies.readPlan(operation.operationId))?.totals.decisionsNeeded).toBe(0);
    await copies.approve(operation.operationId);
    const applied = await settle(copies, operation.operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();

    // Neither side lost a commit; the source branch arrives beside the local one.
    expect(git(serviceB, "rev-parse", "main")).toBe(destinationHead);
    expect(git(serviceB, "rev-parse", "swc/from-M4MAX/main")).toBe(
      git(sourceServiceB, "rev-parse", "main"),
    );
    expect(NodeFS.readFileSync(NodePath.join(folder, "docs/guide.md"), "utf8")).toBe(
      "guide edited on the destination\n",
    );
    const undoPreview = await copies.undoPreview(operation.operationId);
    expect(undoPreview.edited).toBe(0);
    const undone = await copies.undo(operation.operationId, false);
    expect(undone.result?.problems).toEqual([]);
    expect(undone.record.state).toBe("undone");
    const after = snapshot(folder);
    expect(after).toEqual(before);
    note("existing-folder-reconcile-and-undo", {
      rows: plan.rows.map((row) => ({
        id: row.id,
        status: row.status,
        conflicts: row.conflicts.length,
      })),
      decisions,
      keptDestinationCommit: destinationHead,
      sourceBranch: "swc/from-M4MAX/main",
      undoRestored: undone.result?.restored,
      byteForByteAfterUndo: true,
    });
    await copies.close();
  }, 180_000);

  it("leaves the target untouched and returns the source when the copy stops before Apply", async () => {
    const folder = target("cancelled");
    const copies = new DestinationCopies(destinationState("cancelled"), fast);
    const operation = await offer("copy-and-move");
    await copies.start(startInput(operation.operationId, operation.token, folder, "copy-and-move"));
    await settle(copies, operation.operationId, ["previewed"]);
    const cancelled = await copies.cancel(operation.operationId, "Stopped by the verify script");
    expect(cancelled.state).toBe("cancelled");
    expect(NodeFS.existsSync(folder)).toBe(false);
    expect((await transfers.read(operation.operationId))?.state).toBe("released");
    const reason = released.find((entry) => entry.operationId === operation.operationId)?.reason;
    expect(reason).toContain("Stopped by the verify script");

    const small = new DestinationCopies(destinationState("no-space"), {
      ...fast,
      freeBytes: async () => 1,
    });
    const spaceOperation = await offer();
    const spaceTarget = target("no-space");
    await small.start(startInput(spaceOperation.operationId, spaceOperation.token, spaceTarget));
    await settle(small, spaceOperation.operationId, ["previewed"]);
    const refused = await small
      .approve(spaceOperation.operationId)
      .catch((cause: unknown) => cause);
    expect((refused as CopyError).code).toBe("disk_space");
    expect(NodeFS.existsSync(spaceTarget)).toBe(false);

    const older = new DestinationCopies(destinationState("older"), {
      ...fast,
      fetch: async () => new Response("not found", { status: 404 }),
    });
    const outdated = await older
      .start(startInput(NodeCrypto.randomUUID(), "token", target("older")))
      .catch((cause: unknown) => cause);
    expect((outdated as CopyError).code).toBe("outdated_source");
    note("stops-before-apply", {
      cancelledSourceState: "released",
      releaseReason: reason,
      diskSpaceRefusal: (refused as CopyError).message,
      olderSource: (outdated as CopyError).message,
    });
    await Promise.all([copies.close(), small.close(), older.close()]);
  }, 120_000);
  it("sends a ticked secret file privately and never records its value", async () => {
    const canary = `SWC_CANARY_${NodeCrypto.randomBytes(12).toString("hex")}`;
    const secretPath = NodePath.join(fixture.root, ".env.local");
    write(secretPath, `API_TOKEN=${canary}\n`);
    const said: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const original = methods.map((method) => console[method]);
    methods.forEach((method) => {
      console[method] = (...args: unknown[]) => {
        said.push(
          args
            .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg)))
            .join(" "),
        );
      };
    });
    const errors: string[] = [];
    const destinationRoot = destinationState("secrets");
    const folder = target("secrets");
    try {
      const copies = new DestinationCopies(destinationRoot, fast);
      const { operationId, token } = await offer();
      await copies.start(startInput(operationId, token, folder));
      await settle(copies, operationId, ["previewed"]);
      const offered = (await transfers.read(operationId))?.summary?.secretFiles ?? [];
      expect(offered.map((file) => file.path)).toEqual(
        expect.arrayContaining([".env", ".env.local"]),
      );
      const refused = await transfers
        .approveSecrets({ operationId, paths: ["../.env.local"], destinationLabel: "M3" })
        .catch((cause: unknown) => cause);
      errors.push(String((refused as Error).message), JSON.stringify(refused));
      await transfers.approveSecrets({
        operationId,
        paths: [".env.local"],
        destinationLabel: "M3",
      });
      await copies.approve(operationId);
      const applied = await settle(copies, operationId, ["applied", "failed"]);
      expect(applied.error).toBeNull();
      const received = NodePath.join(folder, ".env.local");
      expect(NodeFS.readFileSync(received, "utf8")).toBe(`API_TOKEN=${canary}\n`);
      expect(NodeFS.statSync(received).mode & 0o777).toBe(0o600);
      // The unticked secret stays on the source.
      expect(NodeFS.existsSync(NodePath.join(folder, ".env"))).toBe(false);
      const status = JSON.stringify([
        await copies.read(operationId),
        await transfers.read(operationId),
      ]);
      expect(status).toContain(".env.local");
      const sent = await transfers.sentSecrets.list("env-destination");
      expect(
        sent.some((entry) => entry.operationId === operationId && entry.path === ".env.local"),
      ).toBe(true);

      const stateFiles = [
        ...NodeFS.readdirSync(NodePath.join(base, "source-machine", "state"), {
          recursive: true,
          withFileTypes: true,
        }),
        ...NodeFS.readdirSync(destinationRoot, { recursive: true, withFileTypes: true }),
      ].filter((entry) => entry.isFile());
      const leaking = stateFiles
        .map((entry) => NodePath.join(entry.parentPath, entry.name))
        .filter((file) => NodeFS.readFileSync(file).includes(canary));
      expect(leaking).toEqual([]);
      expect(status).not.toContain(canary);
      expect(errors.join("\n")).not.toContain(canary);
      expect(said.join("\n")).not.toContain(canary);
      note("secret-canary", {
        sentPath: ".env.local",
        mode: "0600",
        stateFilesScanned: stateFiles.length,
        consoleLinesScanned: said.length,
        canaryFound: leaking,
      });
      await copies.close();
    } finally {
      methods.forEach((method, index) => {
        console[method] = original[index]!;
      });
      NodeFS.rmSync(secretPath, { force: true });
    }
  }, 120_000);
});
