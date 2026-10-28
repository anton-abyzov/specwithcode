import { useState } from "react";
import type {
  FolderCopyRow,
  FolderCopyStatus,
  FolderCopyChoice,
} from "@specweave-studio/contracts";
import { CopyPlanPreview } from "../../src/components/studio/HandoffCopyPreview";

const rows: FolderCopyRow[] = [
  {
    id: "repo:.",
    kind: "repository",
    path: ".",
    status: "dirty",
    detail: "Behind the source, with uncommitted changes here.",
    filesToMove: 16941,
    bytesToMove: 295000000,
    bytesPresent: 2200000000,
    needsDecision: true,
    choices: ["keep-mine", "take-theirs"],
    decision: null,
    clone: false,
    cloneAvailable: false,
    conflicts: Array.from({ length: 46 }, (_, n) => ({
      id: `file:${n}`,
      path: `.specweave/increments/0734-example/${n % 2 ? "reports/verify.md" : "ledger.jsonl"}-${n}`,
      reason: "differs",
      choices: ["keep-mine", "take-theirs", "keep-both"],
      decision: null,
    })),
    moreConflicts: 0,
  },
  ...[
    "vskill",
    "specweave",
    "greet-anton",
    "vskill-platform",
    "specweave-status",
    "specweave-studio",
  ].map((name): FolderCopyRow => ({
    id: `repo:${name}`,
    kind: "repository",
    path: `repositories/anton-abyzov/${name}`,
    status: "conflict",
    detail:
      "Files already occupy this path; the destination scan did not identify a repository here.",
    filesToMove: 0,
    bytesToMove: 0,
    bytesPresent: 0,
    choices: ["keep-mine", "take-theirs"],
    decision: null,
    needsDecision: true,
    conflicts: [],
    moreConflicts: 0,
    cloneAvailable: true,
    clone: false,
  })),
];
const status: FolderCopyStatus = {
  operationId: "fixture",
  sourceEnvironmentId: "m4" as never,
  sourceProjectId: "fixture" as never,
  sourceMachine: "MacBook M4",
  mode: "copy-only",
  targetFolder: "/projects/specweave",
  title: "SpecWeave",
  selection: [],
  mirror: false,
  state: "previewed",
  failedStep: null,
  error: null,
  progress: null,
  disk: null,
  rows,
  totals: {
    filesToMove: 16941,
    bytesToMove: 295000000,
    bytesPresent: 2200000000,
    decisionsNeeded: 53,
  },
  checks: [],
  warnings: [],
  unstable: [],
  committed: false,
  projectId: null,
  createdAt: "2026-10-27T00:00:00Z",
  updatedAt: "2026-10-27T00:00:00Z",
};
export function PreviewClarity() {
  const [lastChoice, setLastChoice] = useState<Readonly<Record<string, FolderCopyChoice>>>({});
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <section className="mx-auto max-w-3xl space-y-4 rounded-xl border bg-background p-4 sm:p-6">
        <h1 className="text-xl font-semibold">Continue on another machine</h1>
        <p className="text-muted-foreground">Compare SpecWeave from MacBook M4 with ministorm.</p>
        <CopyPlanPreview
          status={status}
          onDecide={setLastChoice}
          onClone={() => {}}
          disabled={false}
          machines={{ here: "ministorm", source: "MacBook M4" }}
          rootLabel="Umbrella root"
        />
        <p className="text-xs text-muted-foreground">
          Synthetic comparison only. No transfer can run in this fixture.
        </p>
        <output data-slot="fixture-last-choice" className="block break-all text-xs">
          {JSON.stringify(lastChoice)}
        </output>
      </section>
    </main>
  );
}
