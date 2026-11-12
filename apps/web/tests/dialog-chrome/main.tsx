import { createRoot } from "react-dom/client";
import { useState, type ReactNode } from "react";
import { MachineHandoffDialog } from "../../src/components/studio/MachineHandoffDialog";
import { HandoffCopyActions } from "../../src/components/studio/HandoffCopyActions";
import { HandOffThreadDialogView } from "../../src/components/handoff/HandOffThreadDialog";
import { PhoneSetupDialog } from "../../src/components/settings/PhoneSetupDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../src/components/ui/alert-dialog";
import { Button } from "../../src/components/ui/button";
import { Kbd } from "../../src/components/ui/kbd";
import {
  WizardFooter,
  WizardHeader,
  WizardPanel,
  WizardPopup,
} from "../../src/components/ui/wizard";
import { applyPlatform, platformOf } from "../../src/lib/platformConventions";
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
// ?platform= draws the page as that system would; without it the page follows this one.
const asked = params.get("platform");
applyPlatform(
  document.documentElement,
  asked === "macos" || asked === "windows" || asked === "linux"
    ? asked
    : platformOf(navigator.platform, navigator.userAgent),
);
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

/** A destructive confirm: it must open on the safe button whichever side that is drawn on. */
function Confirm() {
  const [open, setOpen] = useState(true);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the "Deploy" action?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive">Delete</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** A footer with a control at the start: it stays there while the buttons follow the system. */
function LeadingDialog() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rename machine</DialogTitle>
          <DialogDescription>Shown in pickers, handoffs and the fleet list.</DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare">
          <Button variant="ghost" className="me-auto">
            Use the default name
          </Button>
          <Button variant="outline">Cancel</Button>
          <Button>Save</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The same with the margin written the other ways callers write it. */
function LeadingAtWidth() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Push to the default branch?</DialogTitle>
          <DialogDescription>This branch is protected on the remote.</DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare">
          <Button variant="outline" className="w-full sm:mr-auto sm:w-auto">
            Abort
          </Button>
          <Button variant="outline">Cancel</Button>
          <Button>Save</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A footer that spreads a note and one button apart is not a row of buttons: it never flips. */
function Between() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Model prices</DialogTitle>
          <DialogDescription>Prices used for cost estimates.</DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare" className="items-center sm:justify-between">
          <span className="text-muted-foreground text-xs">No known price</span>
          <Button>Set price</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A step with Back keeps Back before the default on every system. */
function BackStep() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <WizardPopup>
        <WizardHeader title="Publish repository" description="Step 2 of 2." />
        <WizardPanel>
          <p className="text-sm">Name the repository.</p>
        </WizardPanel>
        <WizardFooter buttonOrder="source">
          <Button variant="outline">Back</Button>
          <Button>Next</Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

function WizardCase() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <WizardPopup>
        <WizardHeader title="Set up this machine" description="Two steps, about a minute." />
        <WizardPanel>
          <p className="text-sm">Choose where projects are kept.</p>
        </WizardPanel>
        <WizardFooter
          leading={
            <label className="flex items-center gap-2 text-muted-foreground text-xs">
              <input type="checkbox" /> Don&apos;t show this again
            </label>
          }
        >
          <Button variant="ghost">Not now</Button>
          <Button>Continue</Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

const FOLDERS = [
  "atlas-api",
  "billing",
  "checkout",
  "design-tokens",
  "docs",
  "edge-proxy",
  "fixtures",
  "gateway",
  "ios-app",
  "landing",
  "mailer",
  "notebooks",
  "ops",
  "payments",
  "website",
];

/** The parts a system changes: a field, a list with a selection, a scroller and key hints. */
function Chrome() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add a folder</DialogTitle>
          <DialogDescription>Type a path, or pick a folder below.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <input
            aria-label="Folder path"
            className="w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            defaultValue="~/Projects/"
          />
          <div
            role="listbox"
            aria-label="Folders"
            data-slot="chrome-scroller"
            className="mt-3 h-40 overflow-y-auto rounded-md border p-1.5"
          >
            {FOLDERS.map((name, index) => (
              <div
                key={name}
                role="option"
                aria-selected={index === 1}
                // The row the keys are on, as a select marks it while its value is another row.
                data-highlighted={index === 3 ? "" : undefined}
                tabIndex={-1}
                className="flex items-center justify-between rounded px-2 py-1.5 text-sm aria-selected:bg-muted"
              >
                <span>{name}</span>
                <span className="text-muted-foreground text-xs">folder</span>
              </div>
            ))}
          </div>
          <p className="pt-3 text-muted-foreground text-xs" data-slot="chrome-keys">
            <Kbd keyName="tab" /> opens it, <Kbd keyName="enter" /> adds it,{" "}
            <Kbd keyName="escape" /> closes and <Kbd shortcut="o" /> opens the system dialog…
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button>Add folder</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const cases: Record<string, () => ReactNode> = {
  confirm: Confirm,
  leading: LeadingDialog,
  "leading-sm": LeadingAtWidth,
  between: Between,
  back: BackStep,
  wizard: WizardCase,
  chrome: Chrome,
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
