import { describe, expect, it } from "@effect/vitest";
import {
  FolderCopyError,
  FolderCopySourceStatus,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { copyStatus, folderCopyError, sourceStatus } from "./FolderCopyHandoff.ts";
import { CopyError, type DestinationRecord } from "./folderTransfer/destinationService.ts";
import { emptyTotals } from "./folderTransfer/manifest.ts";
import { planReconcile } from "./folderTransfer/reconcile.ts";
import { SourceTransferError, type SourceOperationRecord } from "./folderTransfer/sourceService.ts";

const record: DestinationRecord = {
  version: 1,
  operationId: "op-1",
  sourceUrl: "https://source.example.ts.net",
  token: "grant-token-never-shown",
  sourceEnvironmentId: "source-env",
  sourceProjectId: "source-project",
  sourceMachine: "M".repeat(400),
  mode: "copy-only",
  targetFolder: "/tmp/copy",
  title: "Project",
  selection: [],
  decisions: {},
  clone: [],
  mirror: false,
  state: "failed",
  failedStep: "transferring",
  error: { code: "copy_failed", message: "x".repeat(5000) },
  progress: null,
  disk: null,
  checks: [],
  warnings: [],
  unstable: [],
  committed: false,
  projectId: null,
  requestedProjectId: null,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};

describe("FolderCopyHandoff", () => {
  it("never puts the transfer grant into a status and bounds its text", () => {
    const status = copyStatus(record, null);
    expect(JSON.stringify(status)).not.toContain("grant-token-never-shown");
    expect(status.sourceMachine).toHaveLength(200);
    expect(status.error?.message).toHaveLength(4000);
    expect(status.rows).toEqual([]);
  });

  it("maps transfer failures to the wire errors the dialog explains", () => {
    expect(folderCopyError(new CopyError("cancelled", "stopped")).code).toBe("refused");
    expect(folderCopyError(new CopyError("disk_space", "Needs 3 GB")).detail).toBe("Needs 3 GB");
    expect(folderCopyError(new SourceTransferError(404, "not_found")).code).toBe("not_found");
    expect(folderCopyError(new SourceTransferError(401, "unauthorized")).code).toBe("unauthorized");
    expect(folderCopyError(new SourceTransferError(409, "committed")).code).toBe("refused");
    expect(folderCopyError(new SourceTransferError(409, "conflict")).code).toBe("invalid");
    expect(folderCopyError(new Error("boom")).code).toBe("copy_failed");
    const same = new FolderCopyError({ code: "busy" });
    expect(folderCopyError(same)).toBe(same);
  });

  it("caps skipped worktree lists at 200 and keeps their true counts", () => {
    const paths = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
    const source = {
      version: 1,
      operationId: "00000000-0000-4000-8000-000000000002",
      projectId: "source-project",
      folder: "/tmp/source",
      mode: "copy-only",
      destinationEnvironmentId: "destination-env",
      createdAt: 0,
      grant: {},
      state: "scanned",
      selection: null,
      progress: null,
      error: null,
      releaseReason: null,
      summary: {
        totals: emptyTotals(),
        repositories: [],
        secretFiles: [],
        linksOutside: 0,
        warnings: [],
        skipped: {
          rebuildableFolders: 0,
          worktrees: paths("wt", 300),
          dirtyWorktrees: paths("dirty", 250),
          uncheckedWorktrees: paths("unchecked", 210),
          strandedWorktrees: paths("stranded", 3),
          worktreeCount: 300,
          dirtyCount: 250,
        },
      },
    } as unknown as SourceOperationRecord;
    const skipped = sourceStatus(source).summary?.skipped;
    expect(skipped?.worktrees).toHaveLength(200);
    expect(skipped?.dirtyWorktrees).toHaveLength(200);
    expect(skipped?.uncheckedWorktrees).toHaveLength(200);
    expect(skipped?.strandedWorktrees).toEqual(["stranded-0", "stranded-1", "stranded-2"]);
    expect(skipped).toMatchObject({ worktreeCount: 300, dirtyCount: 250 });
    expect(() =>
      Schema.decodeUnknownSync(FolderCopySourceStatus)(sourceStatus(source)),
    ).not.toThrow();
  });

  it("shows how many destination files each row replaces, and the total", () => {
    const plan = planReconcile({
      sourceMachine: "M4",
      repositories: [
        {
          path: ".",
          kind: "main",
          head: "a".repeat(40),
          branch: "main",
          branches: { main: "a".repeat(40) },
          stash: null,
          stashCount: 0,
          identity: "github.com/acme/app",
          origin: null,
          status: [" M b.ts"],
          worktrees: [],
          mainRepository: null,
        },
      ],
      entries: [
        {
          path: "b.ts",
          type: "file",
          mode: 0o644,
          size: 2,
          mtimeMs: 1,
          class: "tracked",
          repo: ".",
          sha256: "b2".padEnd(64, "0"),
          chunks: ["b2".padEnd(64, "0")],
        },
      ],
      targetRoot: "/tmp/copy",
      destination: {
        files: [
          {
            path: "b.ts",
            type: "file",
            size: 2,
            sha256: "b1".padEnd(64, "0"),
            class: "tracked",
            repo: ".",
          },
        ],
        repositories: [
          {
            path: ".",
            kind: "main",
            head: "a".repeat(40),
            branch: "main",
            branches: { main: "a".repeat(40) },
            identity: "github.com/acme/app",
            status: [],
          },
        ],
      },
      relations: { ".": "same" },
      caseInsensitive: false,
    });
    const status = copyStatus(
      {
        ...record,
        operationId: "00000000-0000-4000-8000-000000000003",
        state: "previewed",
        failedStep: null,
        error: null,
      },
      plan,
    );
    expect(status.rows[0]).toMatchObject({ status: "same", needsDecision: false, replacing: 1 });
    expect(status.totals).toMatchObject({ decisionsNeeded: 0, replacing: 1 });
    expect(() => Schema.decodeUnknownSync(FolderCopyStatus)(status)).not.toThrow();
  });
});
