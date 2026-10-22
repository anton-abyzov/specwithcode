// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off - Standalone host verifier owns native HTTP, wall-clock deadlines, signal cleanup and receipt output.
// A disposable cross-machine harness around the actual folder-transfer engine.
// Never opens the app's store, registers projects, copies credentials, or runs providers.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { DEFAULT_SELECTION } from "../src/fleet/folderTransfer/classify.ts";
import { DestinationCopies } from "../src/fleet/folderTransfer/destinationService.ts";
import { runGit } from "../src/fleet/folderTransfer/git.ts";
import {
  hashFile,
  hashSelected,
  scanFolder,
  selectEntries,
} from "../src/fleet/folderTransfer/manifest.ts";
import {
  handleSourceRequest,
  FOLDER_TRANSFER_PREFIX,
} from "../src/fleet/folderTransfer/sourceRoutes.ts";
import { SourceTransfers } from "../src/fleet/folderTransfer/sourceService.ts";

const [role, configFile] = process.argv.slice(2);
assert.equal(process.versions.node.split(".")[0], "22", "Use Node 22 for acceptance");
const config = JSON.parse(await fs.readFile(configFile!, "utf8"));
const json = async (file: string, value: unknown) => {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temporary, file);
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function serve(
  transfers: SourceTransfers,
  environmentId: string,
  counts: Record<string, number> = {},
) {
  const server = http.createServer(async (request, response) => {
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
    assert.ok(Date.now() < deadline, "Copy timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** APFS cannot originate both names, so exercise this Linux behavior on Linux. */
async function linuxCaseCheck(base: string, targetAlias?: string) {
  const source = path.join(base, "linux-case-source");
  const target = targetAlias ?? path.join(base, "linux-case-target");
  await fs.mkdir(source, { mode: 0o700 });
  await fs.writeFile(path.join(source, "Readme.txt"), "Mixed case\n", { flag: "wx" });
  await fs.writeFile(path.join(source, "README.txt"), "Upper case\n", { flag: "wx" });
  await fs.symlink("Readme.txt", path.join(source, "readme-link"));
  await fs.writeFile(path.join(source, "execute.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.mkdir(path.join(source, "node_modules"));
  await fs.writeFile(
    path.join(source, "node_modules/rebuildable-placeholder.txt"),
    "must not arrive\n",
  );
  await fs.writeFile(path.join(source, ".env.local"), "SYNTHETIC_TRANSFER_TEST=must-not-arrive\n");
  const transfers = new SourceTransfers(path.join(base, "linux-case-source-state"));
  const operationId = randomUUID();
  const offer = await transfers.offer({
    operationId,
    projectId: "linux-case",
    folder: source,
    mode: "copy-only",
    destinationEnvironmentId: "linux-case-destination",
  });
  const { server, port } = await serve(transfers, "linux-case-source");
  const copies = new DestinationCopies(path.join(base, "linux-case-destination-state"), {
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
    assert.equal(await fs.readFile(path.join(target, "Readme.txt"), "utf8"), "Mixed case\n");
    assert.equal(await fs.readFile(path.join(target, "README.txt"), "utf8"), "Upper case\n");
    assert.equal(await fs.readlink(path.join(target, "readme-link")), "Readme.txt");
    assert.equal((await fs.stat(path.join(target, "execute.sh"))).mode & 0o777, 0o755);
    const excludedPaths = [
      ".env.local",
      "node_modules",
      "node_modules/rebuildable-placeholder.txt",
    ];
    for (const relative of excludedPaths)
      assert.equal(
        await fs.lstat(path.join(target, relative)).then(
          () => true,
          () => false,
        ),
        false,
        `Excluded path arrived: ${relative}`,
      );
    const receivedEntries = (await fs.readdir(target)).sort();
    assert.deepEqual(
      receivedEntries,
      ["README.txt", "Readme.txt", "execute.sh", "readme-link"],
      "No extra or rebuildable entries may arrive",
    );
    const undone = await copies.undo(operationId, false);
    assert.equal(undone.record.state, "undone");
    assert.equal(
      await fs.lstat(target).then(
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

async function capture(folder: string) {
  const scan = await scanFolder(folder);
  const selection = new Set(DEFAULT_SELECTION);
  await hashSelected(scan, selection);
  const entries = selectEntries(scan.entries, selection).map((entry) => ({
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    ...(entry.type === "file" ? { size: entry.size, sha256: entry.sha256 } : {}),
    ...(entry.type === "symlink" ? { target: entry.target } : {}),
  }));
  const repositories = await Promise.all(
    scan.repositories.map(async (repository) => {
      const cwd = path.join(folder, repository.path);
      const git = async (args: string[]) => (await runGit(cwd, args)).stdout.trim();
      return {
        path: repository.path,
        head: await git(["rev-parse", "HEAD"]),
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
  const before = await capture(config.folder);
  await json(config.expectedFile, before);
  const transfers = new SourceTransfers(config.stateRoot);
  const operationId = randomUUID();
  const offered = await transfers.offer({
    operationId,
    projectId: "remote-copy-fixture",
    folder: config.folder,
    mode: "copy-only",
    destinationEnvironmentId: "remote-copy-ministorm",
  });
  const counts: Record<string, number> = {};
  const { server, port } = await serve(transfers, "remote-copy-source", counts);
  await json(config.offerFile, { operationId, token: offered.token, port });
  console.log(JSON.stringify({ ready: true, port, files: before.entries.length }));
  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const after = await capture(config.folder);
    const unchanged = before.digest === after.digest;
    const record = await transfers.read(operationId);
    await json(config.receiptFile, {
      sourceUnchanged: unchanged,
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
    process.exit(unchanged ? 0 : 1);
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
  assert.equal(process.platform, "linux", "Remote destination must be Linux");
  const offer = JSON.parse(await fs.readFile(config.offerFile, "utf8"));
  const expected = JSON.parse(await fs.readFile(config.expectedFile, "utf8"));
  assert.equal(
    await fs.lstat(config.targetFolder).then(
      () => true,
      () => false,
    ),
    false,
    "Acceptance target must be new",
  );
  const copies = new DestinationCopies(config.stateRoot, { allowLoopback: true, pollMs: 50 });
  const started = Date.now();
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
    assert.equal(
      await fs.lstat(config.targetFolder).then(
        () => true,
        () => false,
      ),
      false,
      "Preview must not create target",
    );
    await copies.approve(offer.operationId);
    const applied = await settle(copies, offer.operationId, ["applied"]);
    assert.deepEqual(applied.unstable, [], "Immutable fixture must have no unstable files");
    const copied = await capture(config.targetFolder);
    assert.deepEqual(copied.repositories, expected.repositories, "Git state must match");
    assert.deepEqual(
      copied.allPaths.sort(),
      expected.entries.map((entry: { path: string }) => entry.path).sort(),
      "Received entry paths must exactly match the selected source",
    );
    const changedPointers: string[] = [];
    let checkedFiles = 0;
    for (const entry of expected.entries) {
      const location = path.join(config.targetFolder, entry.path);
      const stat = await fs.lstat(location);
      // Linux symlink mode is always 0777; macOS may report 0755. File and
      // directory modes are portable, while a link is checked by type/target.
      if (entry.type !== "symlink")
        assert.equal(stat.mode & 0o777, entry.mode, `Mode differs: ${entry.path}`);
      if (entry.type === "file") {
        const actual = await hashFile(location, false);
        if (
          actual.sha256 !== entry.sha256 &&
          (entry.path.endsWith("/.git") || /\.git\/worktrees\/[^/]+\/gitdir$/.test(entry.path))
        ) {
          changedPointers.push(entry.path); // Git repaired machine-specific worktree paths.
        } else assert.equal(actual.sha256, entry.sha256, `Hash differs: ${entry.path}`);
        checkedFiles += 1;
      } else if (entry.type === "symlink") {
        assert.ok(stat.isSymbolicLink(), `Not a symlink: ${entry.path}`);
        assert.equal(await fs.readlink(location), entry.target);
      } else assert.ok(stat.isDirectory(), `Not a directory: ${entry.path}`);
    }
    const excluded = expected.excluded.filter(
      (entry: { type: string; collapsed: boolean }) =>
        entry.type !== "directory" || entry.collapsed,
    );
    for (const entry of excluded)
      assert.equal(
        await fs.lstat(path.join(config.targetFolder, entry.path)).then(
          () => true,
          () => false,
        ),
        false,
        `Excluded path arrived: ${entry.path}`,
      );
    const preview = await copies.undoPreview(offer.operationId);
    assert.equal(preview.edited, 0, "Untouched copy must undo without force");
    const undone = await copies.undo(offer.operationId, false);
    assert.equal(undone.record.state, "undone");
    assert.equal(
      await fs.lstat(config.targetFolder).then(
        () => true,
        () => false,
      ),
      false,
      "Undo must remove the new target",
    );
    const linuxCase = await linuxCaseCheck(path.dirname(config.stateRoot), config.linuxCaseTarget);
    await json(config.receiptFile, {
      passed: true,
      platform: process.platform,
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
      undoRemovedTarget: true,
      undoEdited: preview.edited,
      linuxCase,
    });
    console.log(
      JSON.stringify({ passed: true, checkedFiles, repositories: copied.repositories.length }),
    );
  } finally {
    await copies.close();
  }
} else if (role === "linux-case") {
  assert.equal(process.platform, "linux");
  const receipt = await linuxCaseCheck(config.base, config.targetAlias);
  await json(config.receiptFile, receipt);
  console.log(JSON.stringify(receipt));
} else throw new Error("Expected source, destination or linux-case");
