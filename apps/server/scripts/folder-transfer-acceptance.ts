// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off - Standalone host verifier owns native HTTP, wall-clock deadlines, signal cleanup and receipt output.
// A disposable cross-machine harness around the actual folder-transfer engine.
// Never opens the app's store, registers projects, copies credentials, or runs providers.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_SELECTION } from "../src/fleet/folderTransfer/classify.ts";
import { DestinationCopies } from "../src/fleet/folderTransfer/destinationService.ts";
import { runGit } from "../src/fleet/folderTransfer/git.ts";
import {
  hashFile,
  hashSelected,
  readManifestFile,
  scanFolder,
  selectEntries,
} from "../src/fleet/folderTransfer/manifest.ts";
import { preparePortableGit, sourceEntryRoot } from "../src/fleet/folderTransfer/portableGit.ts";
import {
  handleSourceRequest,
  FOLDER_TRANSFER_PREFIX,
} from "../src/fleet/folderTransfer/sourceRoutes.ts";
import { SourceTransfers } from "../src/fleet/folderTransfer/sourceService.ts";
import { exerciseRemoteConsolidation } from "./folder-transfer-consolidation.ts";

const [role, configFile] = process.argv.slice(2);
NodeAssert.equal(process.versions.node.split(".")[0], "22", "Use Node 22 for acceptance");
const config = JSON.parse(await NodeFSP.readFile(configFile!, "utf8"));
const json = async (file: string, value: unknown) => {
  const temporary = `${file}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await NodeFSP.rename(temporary, file);
};
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function serve(
  transfers: SourceTransfers,
  environmentId: string,
  counts: Record<string, number> = {},
) {
  const server = NodeHttp.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (!pathname.startsWith(FOLDER_TRANSFER_PREFIX)) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const relative = pathname.slice(FOLDER_TRANSFER_PREFIX.length);
      const action = relative.split("/").at(-1) ?? "";
      counts[action] = (counts[action] ?? 0) + 1;
      const result = await handleSourceRequest(transfers, environmentId, {
        method: request.method ?? "GET",
        path: relative,
        authorization: request.headers.authorization ?? null,
        body: async () => Buffer.concat(chunks),
      });
      response.writeHead(result.status, { "content-type": result.contentType }).end(result.body);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

async function settle(copies: DestinationCopies, operationId: string, states: string[]) {
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    await copies.waitFor(operationId);
    const record = await copies.read(operationId);
    if (record?.state === "failed") throw new Error(JSON.stringify(record.error));
    if (record && states.includes(record.state)) return record;
    NodeAssert.ok(Date.now() < deadline, "Copy timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** APFS cannot originate both names, so exercise this Linux behavior on Linux. */
async function linuxCaseCheck(base: string, targetAlias?: string) {
  const source = NodePath.join(base, "linux-case-source");
  const target = targetAlias ?? NodePath.join(base, "linux-case-target");
  await NodeFSP.mkdir(source, { mode: 0o700 });
  await NodeFSP.writeFile(NodePath.join(source, "Readme.txt"), "Mixed case\n", { flag: "wx" });
  await NodeFSP.writeFile(NodePath.join(source, "README.txt"), "Upper case\n", { flag: "wx" });
  await NodeFSP.symlink("Readme.txt", NodePath.join(source, "readme-link"));
  await NodeFSP.writeFile(NodePath.join(source, "execute.sh"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await NodeFSP.mkdir(NodePath.join(source, "node_modules"));
  await NodeFSP.writeFile(
    NodePath.join(source, "node_modules/rebuildable-placeholder.txt"),
    "must not arrive\n",
  );
  await NodeFSP.writeFile(
    NodePath.join(source, ".env.local"),
    "SYNTHETIC_TRANSFER_TEST=must-not-arrive\n",
  );
  const transfers = new SourceTransfers(NodePath.join(base, "linux-case-source-state"));
  const operationId = NodeCrypto.randomUUID();
  const offer = await transfers.offer({
    operationId,
    projectId: "linux-case",
    folder: source,
    mode: "copy-only",
    destinationEnvironmentId: "linux-case-destination",
  });
  const { server, port } = await serve(transfers, "linux-case-source");
  const copies = new DestinationCopies(NodePath.join(base, "linux-case-destination-state"), {
    allowLoopback: true,
    pollMs: 20,
  });
  try {
    await copies.start({
      operationId,
      token: offer.token,
      sourceUrl: `http://127.0.0.1:${port}`,
      sourceEnvironmentId: "linux-case-source",
      sourceProjectId: "linux-case",
      sourceMachine: "Linux case test",
      mode: "copy-only",
      targetFolder: target,
      title: "Linux case-sensitive filenames",
    });
    await settle(copies, operationId, ["previewed"]);
    await copies.approve(operationId);
    const copied = await settle(copies, operationId, ["applied"]);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(target, "Readme.txt"), "utf8"),
      "Mixed case\n",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(target, "README.txt"), "utf8"),
      "Upper case\n",
    );
    NodeAssert.equal(await NodeFSP.readlink(NodePath.join(target, "readme-link")), "Readme.txt");
    NodeAssert.equal((await NodeFSP.stat(NodePath.join(target, "execute.sh"))).mode & 0o777, 0o755);
    const excludedPaths = [
      ".env.local",
      "node_modules",
      "node_modules/rebuildable-placeholder.txt",
    ];
    for (const relative of excludedPaths)
      NodeAssert.equal(
        await NodeFSP.lstat(NodePath.join(target, relative)).then(
          () => true,
          () => false,
        ),
        false,
        `Excluded path arrived: ${relative}`,
      );
    const receivedEntries = (await NodeFSP.readdir(target)).sort();
    NodeAssert.deepEqual(
      receivedEntries,
      ["README.txt", "Readme.txt", "execute.sh", "readme-link"],
      "No extra or rebuildable entries may arrive",
    );
    const undone = await copies.undo(operationId, false);
    NodeAssert.equal(undone.record.state, "undone");
    NodeAssert.equal(
      await NodeFSP.lstat(target).then(
        () => true,
        () => false,
      ),
      false,
    );
    return {
      passed: true,
      targetFolder: target,
      caseDistinctFiles: ["Readme.txt", "README.txt"],
      symlinkPreserved: true,
      executableMode: "0755",
      excludedPathsAbsent: excludedPaths,
      receivedEntries,
      exactReceivedEntries: true,
      undoRemovedTarget: true,
      warnings: copied.warnings,
    };
  } finally {
    await copies.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function capture(folder: string, portableRoot?: string) {
  let scan = await scanFolder(folder);
  NodeAssert.ok(
    !scan.entries.some((entry) => /(^|\/)statev2\.sqlite(?:-|$)/.test(entry.path)),
    "Never read a live Codex database",
  );
  if (portableRoot) scan = await preparePortableGit(scan, portableRoot);
  const selection = new Set(DEFAULT_SELECTION);
  await hashSelected(scan, selection, undefined, (entry) =>
    portableRoot ? sourceEntryRoot(folder, portableRoot, entry) : folder,
  );
  const entries = selectEntries(scan.entries, selection).map((entry) => ({
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    ...(entry.type === "file" ? { size: entry.size, sha256: entry.sha256 } : {}),
    ...(entry.type === "symlink" ? { target: entry.target } : {}),
  }));
  const repositories = await Promise.all(
    scan.repositories.map(async (repository) => {
      const cwd = NodePath.join(folder, repository.path);
      const git = async (args: string[]) => (await runGit(cwd, args)).stdout.trim();
      return {
        path: repository.path,
        head: await git(["rev-parse", "HEAD"]),
        branch: await git(["branch", "--show-current"]),
        index: await git(["ls-files", "--stage"]),
        refs: await git([
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/heads",
          "refs/stash",
        ]),
        status: await git(["status", "--porcelain=v1", "--untracked-files=all"]),
        stash: await git(["stash", "list", "--format=%H"]),
        fsck: (await runGit(cwd, ["fsck", "--no-dangling", "--connectivity-only"])).code,
      };
    }),
  );
  return {
    entries,
    allPaths: scan.entries.map((entry) => entry.path),
    repositories,
    totals: scan.totals,
    warnings: scan.warnings,
    excluded: scan.entries
      .filter((entry) => !selection.has(entry.class))
      .map((entry) => ({
        path: entry.path,
        class: entry.class,
        type: entry.type,
        collapsed: Boolean(entry.collapsed),
      })),
    digest: digest({ entries, repositories }),
  };
}

if (role === "source") {
  const before = await capture(config.folder, NodePath.join(config.stateRoot, "expected-git"));
  await json(config.expectedFile, before);
  const transfers = new SourceTransfers(config.stateRoot);
  const operationId = NodeCrypto.randomUUID();
  const offered = await transfers.offer({
    operationId,
    projectId: "remote-copy-fixture",
    folder: config.folder,
    mode: "copy-only",
    destinationEnvironmentId: "remote-copy-ministorm",
  });
  const counts: Record<string, number> = {};
  const { server, port } = await serve(transfers, "remote-copy-source", counts);
  const repeat = config.exerciseScenarios
    ? await transfers.offer({
        operationId: NodeCrypto.randomUUID(),
        projectId: "remote-copy-fixture",
        folder: config.folder,
        mode: "copy-only",
        destinationEnvironmentId: "remote-copy-ministorm",
      })
    : null;
  await json(config.offerFile, {
    operationId,
    token: offered.token,
    port,
    repeat: repeat ? { operationId: repeat.record.operationId, token: repeat.token } : null,
  });
  console.log(JSON.stringify({ ready: true, port, files: before.entries.length }));
  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const after = await capture(config.folder, NodePath.join(config.stateRoot, "after-git"));
    const unchanged = before.digest === after.digest;
    const record = await transfers.read(operationId);
    const generatedGitSnapshotRemoved = !(await NodeFSP.stat(
      NodePath.join(config.stateRoot, "folder-sources", operationId, "portable-git"),
    ).catch(() => null));
    await json(config.receiptFile, {
      generatedGitSnapshotRemoved,
      sourceUnchanged: unchanged,
      liveSource: config.liveSource === true,
      sourceReadOnly: true,
      beforeDigest: before.digest,
      afterDigest: after.digest,
      operationId,
      state: record?.state,
      counts,
      totals: before.totals,
      repositoryCount: before.repositories.length,
      repositories: before.repositories,
      selectedEntries: before.entries.length,
      warnings: before.warnings,
    });
    process.exit((unchanged || config.liveSource) && generatedGitSnapshotRemoved ? 0 : 1);
  };
  process.on(
    "SIGTERM",
    () =>
      void finish().catch((error) => {
        console.error(error);
        process.exit(1);
      }),
  );
  process.on(
    "SIGINT",
    () =>
      void finish().catch((error) => {
        console.error(error);
        process.exit(1);
      }),
  );
} else if (role === "destination") {
  // eslint-disable-next-line studio/no-global-process-runtime -- Standalone acceptance CLI verifies the actual destination OS; no Effect runtime is used.
  NodeAssert.equal(NodeOS.platform(), "linux", "Remote destination must be Linux");
  const offer = JSON.parse(await NodeFSP.readFile(config.offerFile, "utf8"));
  const expected = JSON.parse(await NodeFSP.readFile(config.expectedFile, "utf8"));
  NodeAssert.equal(
    await NodeFSP.lstat(config.targetFolder).then(
      () => true,
      () => false,
    ),
    false,
    "Acceptance target must be new",
  );
  const copies = new DestinationCopies(config.stateRoot, { allowLoopback: true, pollMs: 50 });
  const started = Date.now();
  console.log(
    JSON.stringify({
      stage: "destination-started",
      pid: process.pid,
      target: config.targetFolder,
      at: new Date().toISOString(),
    }),
  );
  try {
    await copies.start({
      operationId: offer.operationId,
      token: offer.token,
      sourceUrl: `http://127.0.0.1:${config.port}`,
      sourceEnvironmentId: "remote-copy-source",
      sourceProjectId: "remote-copy-fixture",
      sourceMachine: "Mac acceptance source",
      mode: "copy-only",
      targetFolder: config.targetFolder,
      title: "Disposable SpecWeave transfer acceptance",
    });
    await settle(copies, offer.operationId, ["previewed"]);
    NodeAssert.equal(
      await NodeFSP.lstat(config.targetFolder).then(
        () => true,
        () => false,
      ),
      false,
      "Preview must not create target",
    );
    await copies.approve(offer.operationId);
    const applied = await settle(copies, offer.operationId, ["applied"]);
    if (!config.liveSource)
      NodeAssert.deepEqual(applied.unstable, [], "Immutable fixture must have no unstable files");
    const finalPlan = await copies.readPlan(offer.operationId);
    const received = await readManifestFile(
      NodePath.join(config.stateRoot, "folder-copies", offer.operationId, "manifest.ndjson.gz"),
    );
    const finalEntries = new Map(
      finalPlan!.actions
        .filter((action) => action.entry)
        .map((action) => [action.path, action.entry!]),
    );
    const expectedEntries = config.liveSource
      ? received.entries
          .map((entry) => finalEntries.get(entry.path) ?? entry)
          .filter((entry) => !applied.unstable.includes(entry.path))
      : expected.entries;
    console.log(
      JSON.stringify({
        stage: "applied",
        files: expectedEntries.length,
        elapsedMs: Date.now() - started,
      }),
    );
    const copied = await capture(config.targetFolder);
    if (!config.liveSource)
      NodeAssert.deepEqual(copied.repositories, expected.repositories, "Git state must match");
    NodeAssert.deepEqual(
      copied.allPaths.sort(),
      expectedEntries.map((entry: { path: string }) => entry.path).sort(),
      "Received entry paths must exactly match the selected source",
    );
    const changedPointers: string[] = [];
    let checkedFiles = 0;
    for (const entry of expectedEntries) {
      const location = NodePath.join(config.targetFolder, entry.path);
      const stat = await NodeFSP.lstat(location);
      // Linux symlink mode is always 0777; macOS may report 0755. File and
      // directory modes are portable, while a link is checked by type/target.
      if (entry.type !== "symlink")
        NodeAssert.equal(stat.mode & 0o777, entry.mode, `Mode differs: ${entry.path}`);
      if (entry.type === "file") {
        const actual = await hashFile(location, false);
        if (
          actual.sha256 !== entry.sha256 &&
          (entry.path.endsWith("/.git") || /\.git\/worktrees\/[^/]+\/gitdir$/.test(entry.path))
        ) {
          changedPointers.push(entry.path); // Git repaired machine-specific worktree paths.
        } else NodeAssert.equal(actual.sha256, entry.sha256, `Hash differs: ${entry.path}`);
        checkedFiles += 1;
      } else if (entry.type === "symlink") {
        NodeAssert.ok(stat.isSymbolicLink(), `Not a symlink: ${entry.path}`);
        NodeAssert.equal(await NodeFSP.readlink(location), entry.target);
      } else NodeAssert.ok(stat.isDirectory(), `Not a directory: ${entry.path}`);
    }
    const excluded = expected.excluded.filter(
      (entry: { type: string; collapsed: boolean }) =>
        entry.type !== "directory" || entry.collapsed,
    );
    for (const entry of excluded)
      NodeAssert.equal(
        await NodeFSP.lstat(NodePath.join(config.targetFolder, entry.path)).then(
          () => true,
          () => false,
        ),
        false,
        `Excluded path arrived: ${entry.path}`,
      );
    console.log(
      JSON.stringify({
        stage: "verified",
        checkedFiles,
        repositories: copied.repositories.length,
        elapsedMs: Date.now() - started,
      }),
    );
    const consolidation = offer.repeat
      ? await exerciseRemoteConsolidation({
          copies,
          offer: offer.repeat,
          target: config.targetFolder,
          sourceUrl: `http://127.0.0.1:${config.port}`,
          capture,
          settle,
        })
      : null;
    const preview = await copies.undoPreview(offer.operationId);
    // Completed fixture commits must remain a usable repository. The repeated
    // transaction above proves Undo restores it; the wrapper removes the whole
    // explicitly owned fixture only after recording that evidence.
    if (!consolidation) {
      NodeAssert.equal(preview.edited, 0, "Untouched copy must undo without force");
      const undone = await copies.undo(offer.operationId, false);
      NodeAssert.equal(undone.record.state, "undone");
      NodeAssert.deepEqual(undone.result?.problems, []);
      NodeAssert.equal(
        await NodeFSP.lstat(config.targetFolder).then(
          () => true,
          () => false,
        ),
        false,
        "Undo must remove the new target",
      );
    }
    const linuxCase = await linuxCaseCheck(
      NodePath.dirname(config.stateRoot),
      config.linuxCaseTarget,
    );
    await json(config.receiptFile, {
      passed: true,
      // eslint-disable-next-line studio/no-global-process-runtime -- Standalone acceptance CLI verifies the actual destination OS; no Effect runtime is used.
      platform: NodeOS.platform(),
      liveSource: config.liveSource === true,
      node: process.version,
      operationId: offer.operationId,
      elapsedMs: Date.now() - started,
      targetFolder: config.targetFolder,
      checkedFiles,
      changedPointers,
      repositoryCount: copied.repositories.length,
      repositories: copied.repositories,
      secretFilesExcluded: excluded.filter((entry: { class: string }) => entry.class === "secret")
        .length,
      rebuildablesExcluded: expected.excluded.filter(
        (entry: { class: string }) => entry.class === "rebuildable",
      ).length,
      checks: applied.checks,
      warnings: applied.warnings,
      unstable: applied.unstable,
      previewDidNotWrite: true,
      undoRemovedTarget: !consolidation,
      undoEdited: preview.edited,
      continuedRepositoryRetainedUntilFixtureCleanup: Boolean(consolidation),
      consolidation,
      linuxCase,
    });
    console.log(
      JSON.stringify({ passed: true, checkedFiles, repositories: copied.repositories.length }),
    );
  } finally {
    await copies.close();
  }
} else if (role === "linux-case") {
  // eslint-disable-next-line studio/no-global-process-runtime -- Standalone acceptance CLI verifies the actual destination OS; no Effect runtime is used.
  NodeAssert.equal(NodeOS.platform(), "linux");
  const receipt = await linuxCaseCheck(config.base, config.targetAlias);
  await json(config.receiptFile, receipt);
  console.log(JSON.stringify(receipt));
} else throw new Error("Expected source, destination or linux-case");
