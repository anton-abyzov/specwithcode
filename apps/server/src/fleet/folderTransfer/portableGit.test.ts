// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable real Git repositories and two isolated transfer sides.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DEFAULT_SELECTION } from "./classify.ts";
import { DestinationCopies } from "./destinationService.ts";
import { git, write } from "./folderFixture.testkit.ts";
import { scanFolder } from "./manifest.ts";
import { preparePortableGit } from "./portableGit.ts";
import { SourceTransfers } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-portable-git-")),
  );
  roots.push(root);
  const main = NodePath.join(root, "main");
  const selected = NodePath.join(root, "selected");
  NodeFS.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  write(NodePath.join(main, "file.txt"), "initial\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "initial");
  for (const value of ["first stash\n", "second stash\n"]) {
    write(NodePath.join(main, "file.txt"), value);
    git(main, "stash", "push", "-qm", value.trim());
  }
  git(main, "worktree", "add", "-qb", "unfinished", selected);
  write(NodePath.join(selected, "ahead.txt"), "branch-only commit\n");
  git(selected, "add", ".");
  git(selected, "commit", "-qm", "ahead");
  write(NodePath.join(selected, "file.txt"), "staged\n");
  git(selected, "add", "file.txt");
  git(selected, "update-index", "--split-index");
  write(NodePath.join(selected, "file.txt"), "unstaged\n");
  write(NodePath.join(selected, "new.txt"), "untracked\n");
  git(
    main,
    "config",
    "remote.origin.url",
    "https://private:never-transfer@example.invalid/repository.git",
  );
  return { root, main, selected };
}

async function settle(copies: DestinationCopies, id: string, state: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    await copies.waitFor(id);
    const record = await copies.read(id);
    if (record?.state === "failed") throw new Error(JSON.stringify(record.error));
    if (record?.state === state) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Transfer did not reach ${state}`);
}

describe("portable external linked worktrees", () => {
  it("copies Git history, both stashes, staged/unstaged work and branch; continues without the main checkout", async () => {
    const { root, main, selected } = fixture();
    const status = git(selected, "status", "--porcelain=v1");
    const index = git(selected, "ls-files", "--stage");
    const refs = git(selected, "for-each-ref", "--format=%(refname) %(objectname)");
    const stashes = git(selected, "stash", "list", "--format=%H");
    const mainHead = git(main, "rev-parse", "HEAD");
    const target = NodePath.join(root, "destination");
    const sourceState = NodePath.join(root, "source-state");
    const sources = new SourceTransfers(sourceState);
    const id = NodeCrypto.randomUUID();
    const offer = await sources.offer({
      operationId: id,
      projectId: "fixture",
      folder: selected,
      mode: "copy-and-move",
      destinationEnvironmentId: "dest",
    });
    const served = await serveSource(sources, "source");
    await (
      await sources.authorize(id, offer.token)
    ).building;
    const copies = new DestinationCopies(NodePath.join(root, "destination-state"), {
      allowLoopback: true,
      pollMs: 10,
    });
    try {
      await copies.start({
        operationId: id,
        sourceUrl: served.url,
        token: offer.token,
        sourceEnvironmentId: "source",
        sourceProjectId: "fixture",
        sourceMachine: "Mac",
        title: "Portable worktree",
        targetFolder: target,
        mode: "copy-and-move",
        selection: DEFAULT_SELECTION,
      });
      await settle(copies, id, "previewed");
      expect(NodeFS.existsSync(target)).toBe(false);
      expect((await sources.read(id))?.summary?.warnings.join(" ")).toContain(
        "independent Git repository",
      );
      await copies.approve(id);
      const applied = await settle(copies, id, "applied");
      expect(applied.checks.filter((check) => !check.ok)).toEqual([]);
      expect(git(target, "status", "--porcelain=v1")).toBe(status);
      expect(git(target, "ls-files", "--stage")).toBe(index);
      expect(git(target, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs);
      expect(git(target, "stash", "list", "--format=%H")).toBe(stashes);
      expect(git(target, "branch", "--show-current")).toBe("unfinished");
      expect(NodeFS.statSync(NodePath.join(target, ".git")).isDirectory()).toBe(true);
      expect(NodeFS.readFileSync(NodePath.join(target, ".git/config"), "utf8")).not.toContain(
        "never-transfer",
      );
      await expect(
        new SourceTransfers(sourceState).assertCurrentSnapshot(id),
      ).resolves.toBeUndefined();
      git(selected, "branch", "after-copy");
      await expect(
        new SourceTransfers(sourceState).assertCurrentSnapshot(id),
      ).rejects.toMatchObject({ code: "source_changed" });
      git(selected, "branch", "-D", "after-copy");
      git(selected, "add", "file.txt");
      await expect(
        new SourceTransfers(sourceState).assertCurrentSnapshot(id),
      ).rejects.toMatchObject({ code: "source_changed" });
      write(NodePath.join(selected, "file.txt"), "staged\n");
      git(selected, "add", "file.txt");
      write(NodePath.join(selected, "file.txt"), "unstaged\n");
      git(target, "add", ".");
      git(target, "commit", "-qm", "finish on destination");
      expect(git(target, "status", "--porcelain=v1")).toBe("");
      expect(git(selected, "status", "--porcelain=v1")).toBe(status);
      expect(git(main, "rev-parse", "HEAD")).toBe(mainHead);
      expect(git(target, "worktree", "list", "--porcelain")).not.toContain(selected);
      expect(git(target, "worktree", "list", "--porcelain")).not.toContain(main);
      git(target, "fsck", "--connectivity-only");
    } finally {
      await copies.close();
      await served.close();
    }
  }, 60_000);

  it("inventories excluded worktrees without following their working files", async () => {
    const { root, main, selected } = fixture();
    const scan = await scanFolder(main);
    expect(scan.notices?.join(" ")).toContain("selected");
    expect(scan.notices?.join(" ")).toContain("outside this folder are not copied");
    expect(scan.entries.some((entry) => entry.path.includes("new.txt"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(selected, "new.txt"))).toBe(true);
    const prepared = await preparePortableGit(scan, NodePath.join(root, "overlay"));
    expect(
      prepared.entries.some((entry) => entry.path.startsWith(".git/worktrees/selected/")),
    ).toBe(false);
    expect(prepared.entries.some((entry) => entry.path === ".git/refs/heads/unfinished")).toBe(
      true,
    );
  });

  it.each(["sparse-worktree", "separate-git-dir"])(
    "keeps %s usable after independent copying",
    async (kind) => {
      const { root, selected } = fixture();
      let source = selected;
      if (kind === "sparse-worktree") {
        git(source, "reset", "--hard", "HEAD");
        write(NodePath.join(source, "included/file.txt"), "included\n");
        write(NodePath.join(source, "excluded/file.txt"), "excluded\n");
        git(source, "add", ".");
        git(source, "commit", "-qm", "sparse fixture");
        git(source, "sparse-checkout", "init", "--cone", "--sparse-index");
        git(source, "sparse-checkout", "set", "included");
        write(NodePath.join(source, "included/file.txt"), "staged sparse edit\n");
        git(source, "add", "included/file.txt");
      } else {
        source = NodePath.join(root, "gitfile");
        NodeFS.mkdirSync(source);
        git(source, "init", "-q", `--separate-git-dir=${NodePath.join(root, "external-git")}`);
        write(NodePath.join(source, "file.txt"), "initial\n");
        git(source, "add", ".");
        git(source, "commit", "-qm", "separate Git fixture");
        write(NodePath.join(source, "file.txt"), "staged gitfile edit\n");
        git(source, "add", "file.txt");
      }
      const index = git(source, "ls-files", "--stage");
      const status = git(source, "status", "--porcelain=v1");
      const target = NodePath.join(root, "target");
      const sources = new SourceTransfers(NodePath.join(root, "source-state"));
      const id = NodeCrypto.randomUUID();
      const offer = await sources.offer({
        operationId: id,
        projectId: "fixture",
        folder: source,
        mode: "copy-only",
        destinationEnvironmentId: "dest",
      });
      const served = await serveSource(sources, "source");
      await (
        await sources.authorize(id, offer.token)
      ).building;
      const copies = new DestinationCopies(NodePath.join(root, "destination-state"), {
        allowLoopback: true,
        pollMs: 10,
      });
      try {
        await copies.start({
          operationId: id,
          sourceUrl: served.url,
          token: offer.token,
          sourceEnvironmentId: "source",
          sourceProjectId: "fixture",
          sourceMachine: "Mac",
          title: "Portable worktree",
          targetFolder: target,
          mode: "copy-only",
          selection: DEFAULT_SELECTION,
        });
        await settle(copies, id, "previewed");
        await copies.approve(id);
        await settle(copies, id, "applied");
        expect(NodeFS.statSync(NodePath.join(target, ".git")).isDirectory()).toBe(true);
        expect(git(target, "ls-files", "--stage")).toBe(index);
        expect(git(target, "status", "--porcelain=v1")).toBe(status);
        if (kind === "sparse-worktree") {
          expect(git(target, "config", "--bool", "core.sparseCheckout")).toBe("true");
          expect(git(target, "sparse-checkout", "list")).toBe("included");
          expect(NodeFS.existsSync(NodePath.join(target, "excluded/file.txt"))).toBe(false);
        }
        git(target, "commit", "-qm", "continue staged work");
        expect(git(target, "status", "--porcelain=v1")).toBe("");
        git(target, "fsck", "--connectivity-only");
        expect(git(source, "status", "--porcelain=v1")).toBe(status);
      } finally {
        await copies.close();
        await served.close();
      }
    },
    60_000,
  );

  it("refreshes measured external Git state before building the transfer manifest", async () => {
    const { root, selected } = fixture();
    const state = NodePath.join(root, "state");
    const source = new SourceTransfers(state);
    const id = NodeCrypto.randomUUID();
    const offer = await source.offer({
      operationId: id,
      projectId: "fixture",
      folder: selected,
      mode: "copy-only",
      destinationEnvironmentId: "dest",
    });
    const loaded = await source.authorize(id, offer.token);
    await loaded.building;
    git(selected, "add", "file.txt");
    git(selected, "branch", "after-measure");
    await source.requestManifest(loaded, DEFAULT_SELECTION);
    await loaded.building;
    const overlay = NodePath.join(state, "folder-sources", id, "portable-git");
    expect(git(overlay, "ls-files", "--stage")).toBe(git(selected, "ls-files", "--stage"));
    expect(git(overlay, "rev-parse", "after-measure")).toBe(git(selected, "rev-parse", "HEAD"));
  });

  it.each([false, true])(
    "keeps a coherent internal split-index worktree (concurrent commits: %s)",
    async (concurrent) => {
      const { root, main, selected } = fixture();
      const sourceRoot = NodePath.join(root, "umbrella");
      NodeFS.mkdirSync(sourceRoot);
      // Put both working folders inside one selected scope and repair their links.
      const scopedMain = NodePath.join(sourceRoot, "main");
      const scopedLinked = NodePath.join(sourceRoot, "linked");
      NodeFS.renameSync(main, scopedMain);
      NodeFS.renameSync(selected, scopedLinked);
      git(scopedMain, "worktree", "repair", scopedLinked);
      const beforeMain = git(scopedMain, "rev-parse", "HEAD");
      const beforeLinked = git(scopedLinked, "rev-parse", "HEAD");
      const beforeIndex = git(scopedLinked, "ls-files", "--stage");
      const sources = new SourceTransfers(NodePath.join(root, "state"));
      const id = NodeCrypto.randomUUID();
      const offer = await sources.offer({
        operationId: id,
        projectId: "fixture",
        folder: sourceRoot,
        mode: "copy-and-move",
        destinationEnvironmentId: "dest",
      });
      const served = await serveSource(sources, "source");
      const copies = new DestinationCopies(NodePath.join(root, "copies"), {
        allowLoopback: true,
        pollMs: 10,
      });
      const target = NodePath.join(root, "target");
      try {
        await copies.start({
          operationId: id,
          sourceUrl: served.url,
          token: offer.token,
          sourceEnvironmentId: "source",
          sourceProjectId: "fixture",
          sourceMachine: "Mac",
          targetFolder: target,
          title: "Snapshot race",
          mode: "copy-and-move",
          selection: DEFAULT_SELECTION,
        });
        await settle(copies, id, "previewed");
        if (concurrent) {
          git(scopedMain, "commit", "--allow-empty", "-qm", "new main commit during transfer");
          // Commit via commit-tree + update-ref so staged/unstaged work is unchanged.
          const tree = git(scopedLinked, "rev-parse", "HEAD^{tree}");
          const commit = git(
            scopedLinked,
            "commit-tree",
            tree,
            "-p",
            beforeLinked,
            "-m",
            "new linked commit during transfer",
          );
          git(scopedLinked, "update-ref", "refs/heads/unfinished", commit);
        }
        await copies.approve(id);
        const applied = await settle(copies, id, "applied");
        expect(applied.checks.filter((check) => !check.ok)).toEqual([]);
        expect(git(NodePath.join(target, "main"), "rev-parse", "HEAD")).toBe(beforeMain);
        expect(git(NodePath.join(target, "linked"), "rev-parse", "HEAD")).toBe(beforeLinked);
        git(NodePath.join(target, "main"), "fsck", "--connectivity-only");
        git(NodePath.join(target, "linked"), "fsck", "--connectivity-only");
        expect(git(NodePath.join(target, "linked"), "ls-files", "--stage")).toBe(beforeIndex);
        expect(git(NodePath.join(target, "main"), "worktree", "list", "--porcelain")).not.toContain(
          sourceRoot,
        );
        if (concurrent)
          await expect(sources.assertCurrentSnapshot(id)).rejects.toMatchObject({
            code: "source_changed",
          });
        else {
          await expect(sources.assertCurrentSnapshot(id)).resolves.toBeUndefined();
          await expect(sources.assertCurrentSnapshot(id)).resolves.toBeUndefined();
        }
      } finally {
        await copies.close();
        await served.close();
      }
    },
    60_000,
  );

  it("refuses active rebase metadata instead of shipping source-machine paths", async () => {
    const { root, selected } = fixture();
    const gitDir = git(selected, "rev-parse", "--path-format=absolute", "--git-dir");
    NodeFS.mkdirSync(NodePath.join(gitDir, "rebase-merge"));
    const source = new SourceTransfers(NodePath.join(root, "state"));
    const id = NodeCrypto.randomUUID();
    const offer = await source.offer({
      operationId: id,
      projectId: "fixture",
      folder: selected,
      mode: "copy-only",
      destinationEnvironmentId: "dest",
    });
    const loaded = await source.authorize(id, offer.token);
    await expect(source.requestManifest(loaded, DEFAULT_SELECTION)).rejects.toMatchObject({
      code: "failed",
    });
    expect((await source.read(id))?.error).toContain("in-progress Git");
  });
});
