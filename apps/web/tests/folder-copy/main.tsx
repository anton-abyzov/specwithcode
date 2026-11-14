import { PreviewClarity } from "./previewClarity";
import { ProgressGallery } from "./progressGallery";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { HandoffFolderCopy } from "../../src/components/studio/HandoffFolderCopy";
import { MachineHandoffDialog } from "../../src/components/studio/MachineHandoffDialog";
import "../machine-handoff/fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
// `?short=1`: short machine names, as Settings > Machines shows them after renaming.
const MACHINES = params.has("short")
  ? [
      { id: "linux" as never, label: "linux-box", unavailable: null },
      { id: "m1" as never, label: "m1", unavailable: null },
      { id: "m5" as never, label: "m5", unavailable: null },
    ]
  : [
      { id: "m1" as never, label: "Anton’s MacBook Pro M1Max (190)", unavailable: null },
      { id: "m3" as never, label: "Anton’s MacBook Pro", unavailable: null },
      { id: "linux" as never, label: "ministorm", unavailable: null },
    ];
/** `?git=1`: the Git only screen, as Details > Git only, no file copy shows it. */
function GitFixture() {
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <MachineHandoffDialog
        open
        onOpenChange={() => {}}
        sourceLabel="m4"
        projectTitle="specweave"
        workspaceContext={{
          projectFolder: "/Users/you/Projects/github/specweave-umb",
          repository: "/Users/you/Projects/github/specweave-umb",
          checkout: "/Users/you/Projects/github/specweave-umb",
          mode: "local",
        }}
        destinations={[
          {
            key: "m5:project",
            environmentId: "m5",
            label: "m5",
            folder: "/Users/you/Projects/github/specweave-umb",
            unavailable: null,
          },
        ]}
        selected="m5:project"
        onSelect={() => {}}
        machines={[
          { value: "linux", label: "linux-box", tone: "ready", reason: null, disabled: false },
          { value: "m5", label: "m5", tone: "ready", reason: null, disabled: false },
        ]}
        machine="m5"
        method="folder"
        onMethodChange={() => {}}
        onIntentChange={() => {}}
        sourceChanges={{
          state: "dirty",
          fileCount: 18,
          committing: false,
          error: null,
          onCommit: () => {},
        }}
        preview={null}
        phase="choose"
        consent={false}
        onConsent={() => {}}
        error={null}
        onReview={() => {}}
        onContinue={() => {}}
        onOpenDestination={() => {}}
      />
    </main>
  );
}
function Fixture() {
  const [open, setOpen] = useState(true);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [intent, setIntent] = useState<"move" | "copy">("copy");
  const [doneOn, setDoneOn] = useState<string | null>(null);
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      {/* Reopening remounts the copy flow, as closing and reopening the real dialog does. */}
      {!open && (
        <button type="button" data-slot="fixture-reopen" onClick={() => setOpen(true)}>
          Open the copy again
        </button>
      )}
      <MachineHandoffDialog
        open={open}
        onOpenChange={setOpen}
        sourceLabel={params.has("short") ? "m4" : "MacBook M4"}
        projectTitle={params.has("short") ? "specweave" : "SpecWeave"}
        destinations={[]}
        selected=""
        onSelect={() => {}}
        method="copy"
        onMethodChange={() => {}}
        intent={intent}
        copyBusy={busy}
        copyLocked={locked}
        copyDoneOn={doneOn}
        copyTargetLabel={target}
        copyFlow={
          <HandoffFolderCopy
            project={
              {
                id: "source",
                environmentId: "m4",
                title: "SpecWeave",
                workspaceRoot:
                  "/Users/you/Projects/github/specweave-umb/repositories/anton-abyzov/specweave",
              } as never
            }
            coordinatorId={"coordinator" as never}
            sourceLabel={params.has("short") ? "m4" : "MacBook M4"}
            method="copy"
            machines={MACHINES}
            preferredMachine={(params.has("short") ? "m5" : "linux") as never}
            savedFolder={() => null}
            canMove
            uncommittedFiles={params.has("uncommitted") ? Number(params.get("uncommitted")) : null}
            defaultMode="copy-only"
            onChoicesChange={({ mode, machine, done }) => {
              setIntent(mode === "copy-and-move" ? "move" : "copy");
              setTarget(MACHINES.find((item) => item.id === machine)?.label ?? null);
              // As the real dialog does: the title says where a finished copy is.
              setDoneOn(
                done && machine
                  ? (MACHINES.find((item) => item.id === machine)?.label ?? null)
                  : null,
              );
            }}
            onBusyChange={setBusy}
            onCloseLockChange={setLocked}
            onOpenProject={() => {}}
          />
        }
        preview={null}
        phase="choose"
        consent={false}
        onConsent={() => {}}
        error={null}
        onReview={() => {}}
        onContinue={() => {}}
        onOpenDestination={() => {}}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  params.has("progress") ? (
    <ProgressGallery />
  ) : params.has("preview-clarity") ? (
    <PreviewClarity />
  ) : params.has("git") ? (
    <GitFixture />
  ) : (
    <Fixture />
  ),
);
