import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { FolderCopyStatus } from "./folderCopy.ts";

const status = {
  operationId: "00000000-0000-4000-8000-000000000009",
  sourceEnvironmentId: "source",
  sourceProjectId: "project",
  sourceMachine: "Source",
  mode: "copy-only",
  targetFolder: "/target",
  title: "Fixture",
  selection: [],
  mirror: false,
  state: "failed",
  failedStep: "applied",
  error: null,
  progress: null,
  disk: null,
  rows: [],
  totals: null,
  checks: [],
  warnings: [],
  unstable: [],
  committed: false,
  projectId: null,
  createdAt: "2026-10-27T00:00:00Z",
  updatedAt: "2026-10-27T00:00:00Z",
};

describe("incomplete Undo status compatibility", () => {
  it("accepts legacy status without the marker", () => {
    expect(Schema.decodeUnknownSync(FolderCopyStatus)(status)).not.toHaveProperty("undoIncomplete");
  });
  it("retains the recovery marker on the wire", () => {
    expect(
      Schema.decodeUnknownSync(FolderCopyStatus)({ ...status, undoIncomplete: true })
        .undoIncomplete,
    ).toBe(true);
  });
});
