import { createRoot } from "react-dom/client";
import { useState } from "react";
import { HandoffFolderCopy } from "../../src/components/studio/HandoffFolderCopy";
import { MachineHandoffDialog } from "../../src/components/studio/MachineHandoffDialog";
import "../machine-handoff/fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
function Fixture() {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
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
        copyBusy={busy}
        copyFlow={
          <HandoffFolderCopy
            project={
              {
                id: "source",
                environmentId: "m4",
                title: "SpecWeave",
                workspaceRoot: "/Users/you/Projects/github/specweave-umb",
              } as never
            }
            coordinatorId={"coordinator" as never}
            sourceLabel="MacBook M4"
            method="copy"
            machines={[{ id: "linux" as never, label: "ministorm", unavailable: null }]}
            savedFolder={() => null}
            canMove
            onBusyChange={setBusy}
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
createRoot(document.getElementById("root")!).render(<Fixture />);
