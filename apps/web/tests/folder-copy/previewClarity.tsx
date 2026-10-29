import { HandoffCopyFooter } from "../../src/components/studio/HandoffCopyFooter";
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
  const availabilityCase = new URLSearchParams(location.search).get("availability");
  const footerCopy = {
    ...status,
    rows:
      availabilityCase && availabilityCase !== "choices"
        ? rows.map((row) => ({
            ...row,
            needsDecision: false,
            decision: "take-theirs" as const,
            conflicts: row.conflicts.map((file) => ({ ...file, decision: "take-theirs" as const })),
          }))
        : rows,
    totals: { ...status.totals!, decisionsNeeded: availabilityCase === "choices" ? 53 : 0 },
    disk: availabilityCase === "disk" ? ({ needed: 100, available: 0 } as never) : null,
  };
  const noop = () => {};
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <section className="mx-auto max-w-3xl space-y-4 rounded-xl border bg-background p-4 sm:p-6">
        <h1 className="text-xl font-semibold">Hand off SpecWeave</h1>
        <p className="text-muted-foreground">
          From MacBook M4 to another machine. Nothing there is replaced without asking.
        </p>
        <CopyPlanPreview
          status={availabilityCase ? footerCopy : status}
          onDecide={setLastChoice}
          onClone={() => {}}
          disabled={false}
          machines={{ here: "ministorm", source: "MacBook M4" }}
          rootLabel="Umbrella root"
        />
        {availabilityCase && (
          <HandoffCopyFooter
            stage="preview"
            error={null}
            busy={availabilityCase === "busy"}
            working={false}
            pending={null}
            copy={footerCopy}
            machine={"linux" as never}
            mode="copy-only"
            targetLabel="ministorm"
            auto={false}
            chooseFirst={false}
            selection={[]}
            setupBlocked={false}
            replaced="Some files"
            approveLabel="Copy to ministorm"
            secretsUnconfirmed={availabilityCase === "secrets"}
            failedBeforeApply={false}
            undoPreview={null}
            copyAgain={false}
            contextTransferred={false}
            link={null}
            transferRecovery={false}
            sourceDropped={false}
            onTransfer={null}
            onCancelMeasure={noop}
            onResume={noop}
            onMeasure={noop}
            onPlan={noop}
            onStop={noop}
            onReplaceAll={noop}
            onApply={noop}
            onCopyAgain={noop}
            onRetry={noop}
            onUndo={noop}
            onEndSourceHold={noop}
            onOpen={noop}
            onLink={noop}
            onStartNew={noop}
            onChangeSetup={noop}
          />
        )}
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
