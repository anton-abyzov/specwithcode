// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable local Git/Undo fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import type { JournalEntry } from "./apply.ts";
import { DestinationCopies, type DestinationRecord } from "./destinationService.ts";
import { JsonLog } from "./durable.ts";
import { runGit } from "./git.ts";
import { undoApply } from "./undo.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof NodeFSP>()) }));

async function fixture(withFile = false, draftName = "draft local.txt") {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-stash-undo-"));
  const operationId = NodeCrypto.randomUUID();
  const operation = NodePath.join(root, "state", "folder-copies", operationId);
  const target = NodePath.join(root, "target");
  const backups = NodePath.join(operation, "backups");
  const journal = NodePath.join(operation, "journal.ndjson");
  await NodeFSP.mkdir(backups, { recursive: true });
  await NodeFSP.mkdir(target);
  await runGit(target, ["init", "-q"]);
  await runGit(target, ["config", "core.autocrlf", "false"]);
  await NodeFSP.writeFile(NodePath.join(target, "tracked"), "base\n");
  await NodeFSP.writeFile(NodePath.join(target, "staged"), "base staged\n");
  await runGit(target, ["add", "."]);
  await runGit(target, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  ]);
  await NodeFSP.writeFile(NodePath.join(target, "tracked"), "local unstaged\n");
  await NodeFSP.writeFile(NodePath.join(target, "staged"), "local staged\n");
  await runGit(target, ["add", "staged"]);
  await NodeFSP.writeFile(NodePath.join(target, draftName), "local draft\n");
  await runGit(
    target,
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "stash",
      "push",
      "--include-untracked",
      "-qm",
      "swc-handoff",
    ],
    { env: { GIT_LITERAL_PATHSPECS: "0" } },
  );
  expect((await runGit(target, ["status", "--porcelain"])).stdout).toBe("");
  const sha = (await runGit(target, ["rev-parse", "refs/stash"])).stdout.trim();
  const record: DestinationRecord = {
    version: 1,
    operationId,
    sourceUrl: "https://fixture.example.invalid",
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
    state: "applied",
    failedStep: null,
    error: null,
    progress: null,
    disk: null,
    checks: [],
    warnings: [],
    unstable: [],
    committed: true,
    projectId: null,
    requestedProjectId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await NodeFSP.writeFile(NodePath.join(operation, "operation.json"), JSON.stringify(record));
  const log = new JsonLog<JournalEntry>(journal);
  await log.append({ t: "stash", repo: ".", sha }, true);
  if (withFile) {
    await NodeFSP.mkdir(NodePath.join(target, "blocked"));
    await NodeFSP.writeFile(NodePath.join(target, "blocked/report"), "copied");
    const backup = NodePath.join(backups, "report");
    await NodeFSP.writeFile(backup, "original");
    await log.append({ t: "backup", path: "blocked/report", backup }, true);
    await log.append(
      {
        t: "write",
        path: "blocked/report",
        sha256: NodeCrypto.createHash("sha256").update("copied").digest("hex"),
        linkTarget: null,
      },
      true,
    );
    await log.append({ t: "write-done", path: "blocked/report" }, true);
  }
  await log.close();
  const copies = new DestinationCopies(NodePath.join(root, "state"), {
    fetch: async () => {
      throw new Error("Unexpected source request");
    },
  });
  const assertOriginal = async (tracked = "local unstaged\n") => {
    expect(await NodeFSP.readFile(NodePath.join(target, "tracked"), "utf8")).toBe(tracked);
    expect(await NodeFSP.readFile(NodePath.join(target, "staged"), "utf8")).toBe("local staged\n");
    expect((await runGit(target, ["show", ":staged"])).stdout).toBe("local staged\n");
    expect((await runGit(target, ["show", ":tracked"])).stdout).toBe("base\n");
    expect(await NodeFSP.readFile(NodePath.join(target, draftName), "utf8")).toBe("local draft\n");
  };
  return {
    root,
    target,
    backups,
    journal,
    operationId,
    copies,
    sha,
    assertOriginal,
    close: async () => {
      await copies.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it.each([false, true])(
  "skips a completed stash after a separate file failure, preserving later edits: %s",
  async (laterEdit) => {
    const f = await fixture(true);
    const original = NodeFSP.readdir;
    const spy = vi.spyOn(NodeFSP, "readdir").mockImplementation((async (
      path: unknown,
      options: unknown,
    ) => {
      if (path === NodePath.join(f.target, "blocked"))
        throw Object.assign(new Error("EACCES fixture"), { code: "EACCES" });
      return original(path as string, options as never);
    }) as typeof NodeFSP.readdir);
    try {
      const first = await f.copies.undo(f.operationId, false);
      expect(first.record).toMatchObject({ state: "failed", undoIncomplete: true });
      expect(first.result?.problems).toEqual(["blocked/report: EACCES fixture"]);
      await f.assertOriginal();
      expect((await runGit(f.target, ["stash", "list"])).stdout).toBe("");
      spy.mockRestore();
      if (laterEdit) await NodeFSP.writeFile(NodePath.join(f.target, "tracked"), "later edit\n");
      const second = await f.copies.undo(f.operationId, false);
      expect(second.record).toMatchObject({ state: "undone", undoIncomplete: false, error: null });
      expect(second.result?.problems).toEqual([]);
      expect(await NodeFSP.readFile(NodePath.join(f.target, "blocked/report"), "utf8")).toBe(
        "original",
      );
      await f.assertOriginal(laterEdit ? "later edit\n" : undefined);
      expect(
        (await undoApply({ targetRoot: f.target, backupRoot: f.backups, journalFile: f.journal }))
          .problems,
      ).toEqual([]);
      await f.assertOriginal(laterEdit ? "later edit\n" : undefined);
    } finally {
      spy.mockRestore();
      await f.close();
    }
  },
);

it.each(["undo-stash-intent", "undo-stash-restored", "undo-stash-done"] as const)(
  "reconciles stash interruption at %s",
  async (checkpoint) => {
    const f = await fixture();
    const append = JsonLog.prototype.append;
    let stopped = false;
    const spy = vi.spyOn(JsonLog.prototype, "append").mockImplementation(async function (
      this: JsonLog<JournalEntry>,
      entry: unknown,
      sync?: boolean,
    ) {
      if (this.file === f.journal && (entry as JournalEntry).t === checkpoint && !stopped) {
        stopped = true;
        if (checkpoint === "undo-stash-intent") await append.call(this, entry, sync);
        throw new Error("simulated stash interruption");
      }
      return append.call(this, entry, sync);
    });
    try {
      const first = await f.copies.undo(f.operationId, false);
      expect(stopped).toBe(true);
      expect(first.record.undoIncomplete).toBe(true);
      expect(first.result?.problems.join(" ")).toContain("simulated stash interruption");
      spy.mockRestore();
      const second = await f.copies.undo(f.operationId, false);
      expect(second.result?.problems).toEqual([]);
      expect(second.record).toMatchObject({ state: "undone", undoIncomplete: false });
      await f.assertOriginal();
      expect((await runGit(f.target, ["stash", "list"])).stdout).toBe("");
      expect(
        (await NodeFSP.readdir(f.backups)).filter((name) => name.startsWith(".undo-stash-index")),
      ).toEqual([]);
    } finally {
      spy.mockRestore();
      await f.close();
    }
  },
);

it("keeps later edits after an applied stash loses its completion record, even with assume-unchanged", async () => {
  const f = await fixture();
  const append = JsonLog.prototype.append;
  const spy = vi.spyOn(JsonLog.prototype, "append").mockImplementation(async function (
    this: JsonLog<JournalEntry>,
    entry: unknown,
    sync?: boolean,
  ) {
    if (this.file === f.journal && (entry as JournalEntry).t === "undo-stash-restored")
      throw new Error("lost stash completion");
    return append.call(this, entry, sync);
  });
  try {
    expect((await f.copies.undo(f.operationId, false)).record.undoIncomplete).toBe(true);
    spy.mockRestore();
    await runGit(f.target, ["update-index", "--assume-unchanged", "tracked"]);
    await NodeFSP.writeFile(NodePath.join(f.target, "tracked"), "later edit\n");
    const second = await f.copies.undo(f.operationId, false);
    expect(second.result?.problems.join(" ")).toContain("current edits were kept");
    expect(second.record.undoIncomplete).toBe(true);
    await f.assertOriginal("later edit\n");
    expect((await runGit(f.target, ["stash", "list"])).stdout).toContain("swc-handoff");
  } finally {
    spy.mockRestore();
    await f.close();
  }
});

it("recognizes a legacy already-restored stash from actual trees and index, not stash-list absence alone", async () => {
  const f = await fixture();
  try {
    await runGit(f.target, ["stash", "apply", "--index", "-q", f.sha], {
      env: { GIT_LITERAL_PATHSPECS: "0" },
    }).catch((cause: unknown) => {
      throw new Error((cause as { stderr?: string }).stderr);
    });
    await runGit(f.target, ["stash", "drop", "-q", "stash@{0}"]);
    const result = await f.copies.undo(f.operationId, false);
    expect(result.record).toMatchObject({ state: "undone", undoIncomplete: false });
    expect(result.result?.problems).toEqual([]);
    await f.assertOriginal();
  } finally {
    await f.close();
  }
});

it.each(["normal", "lost-completion", "later-recreated"] as const)(
  "restores a saved unstaged deletion across %s",
  async (phase) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-stash-delete-"));
    const target = NodePath.join(root, "target");
    await NodeFSP.mkdir(target);
    const journalFile = NodePath.join(root, "journal");
    let spy: { mockRestore(): void } | undefined;
    try {
      await runGit(target, ["init", "-q"]);
      await NodeFSP.writeFile(NodePath.join(target, "deleted"), "base\n");
      await runGit(target, ["add", "."]);
      await runGit(target, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "base",
      ]);
      await NodeFSP.rm(NodePath.join(target, "deleted"));
      await runGit(target, ["stash", "push", "-qm", "swc-handoff"], {
        env: { GIT_LITERAL_PATHSPECS: "0" },
      });
      const sha = (await runGit(target, ["rev-parse", "refs/stash"])).stdout.trim();
      const journal = new JsonLog<JournalEntry>(journalFile);
      await journal.append({ t: "stash", repo: ".", sha }, true);
      await journal.close();
      const input = { targetRoot: target, backupRoot: NodePath.join(root, "backups"), journalFile };
      if (phase !== "normal") {
        const append = JsonLog.prototype.append;
        spy = vi.spyOn(JsonLog.prototype, "append").mockImplementation(async function (
          this: JsonLog<JournalEntry>,
          entry: unknown,
          sync?: boolean,
        ) {
          if (this.file === journalFile && (entry as JournalEntry).t === "undo-stash-restored")
            throw new Error("lost deletion completion");
          return append.call(this, entry, sync);
        });
        expect((await undoApply(input)).problems.join(" ")).toContain("lost deletion completion");
        spy.mockRestore();
        expect(
          await NodeFSP.lstat(NodePath.join(target, "deleted")).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      }
      if (phase === "later-recreated")
        await NodeFSP.writeFile(NodePath.join(target, "deleted"), "later work\n");
      const result = await undoApply(input);
      if (phase === "later-recreated") {
        expect(result.problems.join(" ")).toContain("current edits were kept");
        expect(await NodeFSP.readFile(NodePath.join(target, "deleted"), "utf8")).toBe(
          "later work\n",
        );
        expect((await runGit(target, ["stash", "list"])).stdout).toContain("swc-handoff");
      } else {
        expect(result.problems).toEqual([]);
        expect(
          await NodeFSP.lstat(NodePath.join(target, "deleted")).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        expect((await runGit(target, ["stash", "list"])).stdout).toBe("");
        expect((await undoApply(input)).problems).toEqual([]);
      }
    } finally {
      spy?.mockRestore();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

it
  .skipIf(process.platform === "win32")
  .each(["local\ndraft.txt", "local\tdraft.txt", "local\\draft.txt"])(
  "restores existing destination work with a valid POSIX stash filename: %j",
  async (draftName) => {
    const f = await fixture(false, draftName);
    try {
      const result = await f.copies.undo(f.operationId, false);
      expect(result.result?.problems).toEqual([]);
      expect(result.record).toMatchObject({ state: "undone", undoIncomplete: false });
      await f.assertOriginal();
      expect((await runGit(f.target, ["stash", "list"])).stdout).toBe("");
      expect(
        (await undoApply({ targetRoot: f.target, backupRoot: f.backups, journalFile: f.journal }))
          .problems,
      ).toEqual([]);
      await f.assertOriginal();
    } finally {
      await f.close();
    }
  },
);
