// @effect-diagnostics nodeBuiltinImport:off - disposable real originals and copied files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import type { JournalEntry } from "./apply.ts";
import { JsonLog } from "./durable.ts";
import { previewUndo, undoApply } from "./undo.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFSP>()),
}));
const sha = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
async function fixture(paths: string[]) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-undo-replay-"));
  const targetRoot = NodePath.join(root, "target");
  const backupRoot = NodePath.join(root, "backups");
  const journalFile = NodePath.join(root, "journal.ndjson");
  const log = new JsonLog<JournalEntry>(journalFile);
  for (const path of paths) {
    const target = NodePath.join(targetRoot, path);
    const backup = NodePath.join(backupRoot, "files", path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.mkdirSync(NodePath.dirname(backup), { recursive: true });
    NodeFS.writeFileSync(target, `COPIED ${path}`);
    NodeFS.writeFileSync(backup, `ORIGINAL ${path}`);
    await log.append({ t: "backup", path, backup }, true);
    await log.append({ t: "write", path, sha256: sha(`COPIED ${path}`), linkTarget: null }, true);
    await log.append({ t: "write-done", path }, true);
  }
  await log.close();
  return { root, targetRoot, backupRoot, journalFile };
}

it.each([false, true])(
  "retries multi-file Undo without moving restored originals (force: %s)",
  async (force) => {
    const input = await fixture(["blocked/report", "healthy/report"]);
    const readdir = vi
      .spyOn(NodeFSP, "readdir")
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        Object.assign(new Error("EACCES: blocked listing"), { code: "EACCES" }),
      );
    try {
      const first = await undoApply(input);
      readdir.mockRestore();
      expect(first.problems).toEqual(["blocked/report: EACCES: blocked listing"]);
      expect(NodeFS.readFileSync(NodePath.join(input.targetRoot, "healthy/report"), "utf8")).toBe(
        "ORIGINAL healthy/report",
      );
      expect((await previewUndo(input)).edited).toBe(0);
      expect((await undoApply({ ...input, force })).problems).toEqual([]);
      for (const path of ["blocked/report", "healthy/report"])
        expect(NodeFS.readFileSync(NodePath.join(input.targetRoot, path), "utf8")).toBe(
          `ORIGINAL ${path}`,
        );
      NodeFS.writeFileSync(
        NodePath.join(input.targetRoot, "healthy/report"),
        "PERSON EDITED RESTORED ORIGINAL",
      );
      expect((await undoApply({ ...input, force: true })).problems).toEqual([]);
      expect(NodeFS.readFileSync(NodePath.join(input.targetRoot, "healthy/report"), "utf8")).toBe(
        "PERSON EDITED RESTORED ORIGINAL",
      );
      expect(NodeFS.existsSync(NodePath.join(input.backupRoot, "kept-edits"))).toBe(false);
    } finally {
      readdir.mockRestore();
      NodeFS.rmSync(input.root, { recursive: true, force: true });
    }
  },
);

it.each(["intent", "move", "completion", "torn-completion"])(
  "recovers a crash at Undo %s without losing the original",
  async (phase) => {
    const input = await fixture(["report"]);
    const append = JsonLog.prototype.append;
    const journal = vi.spyOn(JsonLog.prototype, "append").mockImplementation(async function (
      this: JsonLog<unknown>,
      value: unknown,
      sync?: boolean,
    ) {
      const entry = value as { t: string };
      if (phase === "torn-completion" && entry.t === "undo-file-done") {
        NodeFS.appendFileSync(input.journalFile, '{"t":"undo-file-');
        throw new Error("injected crash with torn completion");
      }
      if (
        (phase === "intent" && entry.t === "undo-file-intent") ||
        (phase === "completion" && entry.t === "undo-file-done")
      )
        throw new Error("injected crash");
      return append.call(this, value, sync);
    });
    const rename =
      phase === "move"
        ? vi
            .spyOn(NodeFSP, "rename")
            .mockRejectedValueOnce(Object.assign(new Error("injected move crash"), { code: "EIO" }))
        : null;
    try {
      const first = await undoApply(input);
      expect(first.problems.join(" ")).toContain("crash");
      journal.mockRestore();
      rename?.mockRestore();
      if (phase === "intent")
        expect(NodeFS.readFileSync(NodePath.join(input.targetRoot, "report"), "utf8")).toBe(
          "COPIED report",
        );
      expect((await previewUndo(input)).edited).toBe(0);
      expect((await undoApply(input)).problems).toEqual([]);
      expect(NodeFS.readFileSync(NodePath.join(input.targetRoot, "report"), "utf8")).toBe(
        "ORIGINAL report",
      );
      expect(NodeFS.existsSync(NodePath.join(input.backupRoot, "kept-edits"))).toBe(false);
    } finally {
      journal.mockRestore();
      rename?.mockRestore();
      NodeFS.rmSync(input.root, { recursive: true, force: true });
    }
  },
);

it.each(["directory", "symlink"])(
  "reconciles a restored %s before its completion mark",
  async (kind) => {
    const input = await fixture(["report"]);
    const backup = NodePath.join(input.backupRoot, "files", "report");
    NodeFS.rmSync(backup);
    const outside = NodePath.join(input.root, "outside");
    NodeFS.writeFileSync(outside, "EXTERNAL CONTENT");
    if (kind === "directory") {
      NodeFS.mkdirSync(backup);
      NodeFS.writeFileSync(NodePath.join(backup, "child"), "ORIGINAL CHILD");
    } else NodeFS.symlinkSync(outside, backup);
    const append = JsonLog.prototype.append;
    const fault = vi.spyOn(JsonLog.prototype, "append").mockImplementation(async function (
      this: JsonLog<unknown>,
      value: unknown,
      sync?: boolean,
    ) {
      if ((value as { t: string }).t === "undo-file-done") throw new Error("completion crash");
      return append.call(this, value, sync);
    });
    try {
      expect((await undoApply(input)).problems.join(" ")).toContain("completion crash");
      fault.mockRestore();
      expect((await previewUndo(input)).edited).toBe(0);
      expect((await undoApply(input)).problems).toEqual([]);
      const target = NodePath.join(input.targetRoot, "report");
      if (kind === "directory")
        expect(NodeFS.readFileSync(NodePath.join(target, "child"), "utf8")).toBe("ORIGINAL CHILD");
      else expect(NodeFS.readlinkSync(target)).toBe(outside);
      expect(NodeFS.readFileSync(outside, "utf8")).toBe("EXTERNAL CONTENT");
    } finally {
      fault.mockRestore();
      NodeFS.rmSync(input.root, { recursive: true, force: true });
    }
  },
);

it("keeps a possible restored original from a legacy partial Undo even when forced", async () => {
  const input = await fixture(["report"]);
  try {
    NodeFS.renameSync(
      NodePath.join(input.backupRoot, "files", "report"),
      NodePath.join(input.targetRoot, "report"),
    );
    expect((await undoApply({ ...input, force: true })).problems.join(" ")).toContain(
      "original backup is missing",
    );
    expect(NodeFS.readFileSync(NodePath.join(input.targetRoot, "report"), "utf8")).toBe(
      "ORIGINAL report",
    );
  } finally {
    NodeFS.rmSync(input.root, { recursive: true, force: true });
  }
});

it("never classifies an inaccessible pending removal as completed", async () => {
  const input = await fixture(["report"]);
  const log = new JsonLog<JournalEntry>(input.journalFile);
  try {
    await log.append({ t: "undo-file-intent", path: "report", backup: null, digest: null }, true);
    await log.close();
    const error = Object.assign(new Error("EACCES: cannot inspect pending outcome"), {
      code: "EACCES",
    });
    const lstat = vi.spyOn(NodeFSP, "lstat").mockRejectedValueOnce(error);
    try {
      await expect(previewUndo(input)).rejects.toBe(error);
    } finally {
      lstat.mockRestore();
    }
    expect(NodeFS.readFileSync(NodePath.join(input.targetRoot, "report"), "utf8")).toBe(
      "COPIED report",
    );
  } finally {
    await log.close();
    NodeFS.rmSync(input.root, { recursive: true, force: true });
  }
});
