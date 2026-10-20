import { describe, expect, it } from "@effect/vitest";
import { FolderCopyError } from "@specweave-studio/contracts";
import { copyStatus, folderCopyError } from "./FolderCopyHandoff.ts";
import { CopyError, type DestinationRecord } from "./folderTransfer/destinationService.ts";
import { SourceTransferError } from "./folderTransfer/sourceService.ts";

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
});
