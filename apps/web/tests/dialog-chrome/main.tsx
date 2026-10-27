import { createRoot } from "react-dom/client";
import { useState, type ReactNode } from "react";
import { MachineHandoffDialog } from "../../src/components/studio/MachineHandoffDialog";
import { HandoffCopyActions } from "../../src/components/studio/HandoffCopyActions";
import { HandOffThreadDialogView } from "../../src/components/handoff/HandOffThreadDialog";
import { PhoneSetupDialog } from "../../src/components/settings/PhoneSetupDialog";
import { Button } from "../../src/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../src/components/ui/dialog";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../../src/components/ui/sheet";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const noop = () => {};

const destinations = [
  { key: "m1", label: "Mac mini M1", folder: "/Users/anton/Projects/easychamp", unavailable: null },
  { key: "lx", label: "Linux box", folder: "/home/anton/Projects/easychamp", unavailable: null },
];

function MachineCopy() {
  const [open, setOpen] = useState(true);
  return (
    <MachineHandoffDialog
      open={open}
      onOpenChange={setOpen}
      sourceLabel="MacBook Pro M4"
      projectTitle="EasyChamp"
      selected="lx"
      onSelect={noop}
      destinations={destinations}
      preview={null}
      phase="choose"
      error={null}
      consent={false}
      onConsent={noop}
      onReview={noop}
      onContinue={noop}
      onOpenDestination={noop}
      method="copy"
      onMethodChange={noop}
      copyFlow={
        <>
          <p role="alert" className="text-sm text-destructive-foreground">
            The copy stopped: Linux box went offline. Retry when it is back.
          </p>
          <HandoffCopyActions>
            <Button variant="ghost" data-slot="copy-back" className="mr-auto" onClick={noop}>
              Back
            </Button>
            <Button onClick={noop}>Retry</Button>
            <Button variant="outline" onClick={noop}>
              Cancel copy
            </Button>
          </HandoffCopyActions>
        </>
      }
    />
  );
}

function MachineReview() {
  const [open, setOpen] = useState(true);
  return (
    <MachineHandoffDialog
      open={open}
      onOpenChange={setOpen}
      sourceLabel="MacBook Pro M4"
      projectTitle="EasyChamp"
      selected="m1"
      onSelect={noop}
      destinations={destinations}
      preview={{ messageCount: 18, repositories: [{ relativePath: ".", head: "a".repeat(40) }] }}
      phase="review"
      error={null}
      consent
      onConsent={noop}
      onReview={noop}
      onContinue={noop}
      onOpenDestination={noop}
      onBack={noop}
    />
  );
}

function ThreadResult() {
  return (
    <HandOffThreadDialogView
      title="Fix Safari export button"
      destinations={[]}
      destinationId={null}
      onDestination={noop}
      modelPicker={null}
      preflight={{ state: "idle" }}
      onRecheck={noop}
      submitting={false}
      error={null}
      result={{ value: { notice: null } as never, machine: "Mac mini M1" }}
      onSubmit={noop}
      onCancel={noop}
      onOpenContinuation={noop}
    />
  );
}

function Phone() {
  const [open, setOpen] = useState(true);
  return (
    <PhoneSetupDialog
      open={open}
      onOpenChange={setOpen}
      address={null}
      code={null}
      canPair={false}
      isCreating={false}
      error={null}
      hasAccessControls={false}
      onShowAccessSettings={noop}
      onGenerate={noop}
      onCopyAddress={noop}
      onCopyCode={noop}
    />
  );
}

function FormDialog() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rename machine</DialogTitle>
          <DialogDescription>Shown in pickers, handoffs and the fleet list.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <input className="w-full rounded-md border px-3 py-2 text-sm" defaultValue="Mac mini" />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button>Save</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SideSheet() {
  const [open, setOpen] = useState(true);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetPopup>
        <SheetHeader>
          <SheetTitle>Provision a machine</SheetTitle>
          <SheetDescription>Pick a provider and region.</SheetDescription>
        </SheetHeader>
      </SheetPopup>
    </Sheet>
  );
}

const cases: Record<string, () => ReactNode> = {
  "machine-copy": MachineCopy,
  "machine-review": MachineReview,
  "thread-result": ThreadResult,
  phone: Phone,
  form: FormDialog,
  sheet: SideSheet,
};
const Case = cases[params.get("case") ?? "machine-copy"] ?? MachineCopy;

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-background p-8 text-foreground">
    <h1 className="text-lg font-medium">EasyChamp</h1>
    <Case />
  </main>,
);
