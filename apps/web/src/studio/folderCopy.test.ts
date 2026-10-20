import { describe, expect, it } from "vite-plus/test";
import type {
  FolderCopyRow,
  FolderCopySourceSummary,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import {
  cloneableRows,
  copySettled,
  DEFAULT_COPY_SELECTION,
  EXACT_COPY_SELECTION,
  formatBytes,
  isExactCopy,
  progressFraction,
  progressText,
  selectedTotals,
  undecidedRows,
} from "./folderCopy";

const total = (files: number, bytes: number) => ({ files, bytes });
const summary: FolderCopySourceSummary = {
  totals: {
    repository: total(10, 5_000_000),
    tracked: total(100, 2_000_000),
    untracked: total(5, 1_000),
    ignoredData: total(3, 16_000_000_000),
    rebuildable: total(9000, 900_000_000),
    secret: total(2, 300),
  },
  repositories: [],
  secretFiles: [],
  linksOutside: 0,
  warnings: [],
};

const row = (patch: Partial<FolderCopyRow>): FolderCopyRow => ({
  id: "repo:a",
  kind: "repository",
  path: "a",
  status: "same",
  detail: "",
  filesToMove: 0,
  bytesToMove: 0,
  bytesPresent: 0,
  choices: [],
  decision: null,
  needsDecision: false,
  conflicts: [],
  moreConflicts: 0,
  cloneAvailable: false,
  clone: false,
  ...patch,
});

const status = (patch: Partial<FolderCopyStatus>) =>
  ({
    state: "previewed",
    committed: false,
    projectId: null,
    progress: null,
    ...patch,
  }) as FolderCopyStatus;

describe("folder copy helpers", () => {
  it("formats bytes in decimal units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_500)).toBe("1.5 KB");
    expect(formatBytes(54_800_000_000)).toBe("54.8 GB");
    expect(formatBytes(250_000_000)).toBe("250 MB");
  });

  it("defaults to everything except rebuildable and secret files", () => {
    expect(DEFAULT_COPY_SELECTION).toEqual(["repository", "tracked", "untracked", "ignoredData"]);
    expect(isExactCopy(DEFAULT_COPY_SELECTION)).toBe(false);
    expect(isExactCopy(EXACT_COPY_SELECTION)).toBe(true);
    expect(EXACT_COPY_SELECTION).not.toContain("secret");
  });

  it("totals only the selected classes and never secret files", () => {
    expect(selectedTotals(summary, ["tracked", "untracked"])).toEqual({
      files: 105,
      bytes: 2_001_000,
    });
    expect(selectedTotals(summary, ["secret"])).toEqual({ files: 0, bytes: 0 });
  });

  it("counts rows that still need an answer, including file conflicts", () => {
    expect(
      undecidedRows([
        row({ needsDecision: true }),
        row({ id: "repo:b", needsDecision: true, decision: "keep-mine" }),
        row({
          id: "files",
          kind: "files",
          conflicts: [
            { id: "file:x", path: "x", reason: "differs", choices: ["keep-mine"], decision: null },
          ],
        }),
      ]),
    ).toBe(2);
  });

  it("lists repositories that can clone from origin", () => {
    expect(
      cloneableRows([
        row({ cloneAvailable: true }),
        row({ id: "files", kind: "files", cloneAvailable: true }),
      ]),
    ).toEqual(["repo:a"]);
  });

  it("stops polling at review, failure and a registered applied copy", () => {
    expect(copySettled(status({ state: "previewed" }))).toBe(true);
    expect(copySettled(status({ state: "transferring" }))).toBe(false);
    expect(copySettled(status({ state: "applied" }))).toBe(false);
    expect(
      copySettled(status({ state: "applied", committed: true, projectId: "p" as never })),
    ).toBe(true);
    expect(copySettled(status({ state: "failed" }))).toBe(true);
  });

  it("describes progress with files and bytes done and remaining", () => {
    const copying = status({
      state: "transferring",
      progress: {
        phase: "files",
        filesDone: 1200,
        filesTotal: 4000,
        bytesDone: 2_000_000_000,
        bytesTotal: 8_000_000_000,
        bytesLocal: 500_000_000,
      },
    });
    expect(progressText(copying)).toBe(
      "Copying files: 1,200 of 4,000 files, 2.0 GB of 8.0 GB (500 MB already here)",
    );
    expect(progressFraction(copying)).toBe(0.25);
    expect(progressFraction(status({ progress: null }))).toBeNull();
  });
});
