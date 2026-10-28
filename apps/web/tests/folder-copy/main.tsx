import { PreviewClarity } from "./previewClarity";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { HandoffFolderCopy } from "../../src/components/studio/HandoffFolderCopy";
import { MachineHandoffDialog } from "../../src/components/studio/MachineHandoffDialog";
import "../machine-handoff/fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const MACHINES = [
  { id: "m1" as never, label: "Anton’s MacBook Pro M1Max (190)", unavailable: null },
  { id: "m3" as never, label: "Anton’s MacBook Pro", unavailable: null },
  { id: "linux" as never, label: "ministorm", unavailable: null },
];
function Fixture() {
  const [open, setOpen] = useState(true);
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
        sourceLabel="MacBook M4"
        projectTitle="SpecWeave"
        destinations={[]}
        selected=""
        onSelect={() => {}}
        method="copy"
        onMethodChange={() => {}}
        intent={intent}
        copyBusy={busy}
        copyLocked={locked}
        copyDoneOn={doneOn}
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
            sourceLabel="MacBook M4"
            method="copy"
            machines={MACHINES}
            preferredMachine={"linux" as never}
            savedFolder={() => null}
            canMove
            defaultMode="copy-only"
            onChoicesChange={({ mode, machine, done }) => {
              setIntent(mode === "copy-and-move" ? "move" : "copy");
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
  params.has("preview-clarity") ? <PreviewClarity /> : <Fixture />,
);
