import { PreviewClarity } from "./previewClarity";
import { ProgressGallery } from "./progressGallery";
import { ToastGallery } from "./toastGallery";
import { MotionScene } from "./motionScene";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { HandoffFolderCopy } from "../../src/components/studio/HandoffFolderCopy";
import { MachineHandoffDialog } from "../../src/components/studio/MachineHandoffDialog";
import "../machine-handoff/fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
// `?short=1`: short machine names, as Settings > Machines shows them after renaming.
const MACHINES = params.has("short")
  ? [
      { id: "linux" as never, label: "linux-box", unavailable: null },
      { id: "deskB" as never, label: "deskB", unavailable: null },
      { id: "rackF" as never, label: "rackF", unavailable: null },
    ]
  : [
      { id: "deskB" as never, label: "Sam’s long-named workstation (190)", unavailable: null },
      { id: "kioskD" as never, label: "Sam’s workstation", unavailable: null },
      { id: "linux" as never, label: "box-a", unavailable: null },
    ];
/** `?git=1`: the Git handoff screen, as "Continue the coordinator here" opens it. */
function GitFixture() {
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <MachineHandoffDialog
        open
        onOpenChange={() => {}}
        sourceLabel="laptopE"
        projectTitle="specweave"
        workspaceContext={{
          projectFolder: "/Users/you/projects/atlas",
          repository: "/Users/you/projects/atlas",
          checkout: "/Users/you/projects/atlas",
          mode: "local",
        }}
        destinations={[
          {
            key: "rackF:project",
            environmentId: "rackF",
            label: "rackF",
            folder: "/Users/you/projects/atlas",
            unavailable: null,
          },
        ]}
        selected="rackF:project"
        onSelect={() => {}}
        machines={[
          { value: "linux", label: "linux-box", tone: "ready", reason: null, disabled: false },
          { value: "rackF", label: "rackF", tone: "ready", reason: null, disabled: false },
        ]}
        machine="rackF"
        method="folder"
        onMethodChange={() => {}}
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
/**
 * `?holding=copy|main|several|several-main|none`: what the chosen machine already holds, as
 * Copy to another machine… reads it. The coordinator is on laptopE (this machine) unless rackF holds it.
 * `?unlinked=1`: opened from deskB, while rackF has this repository as a separate project
 * (coordinator on laptopE). `?makemain=1|blocked`: the done screen offers the page's
 * "Continue the coordinator on {machine}" switch.
 * `?move=1`, or a `fixture-move` event: a move asked for with "Continue the coordinator here".
 */
// `?method=clone`: the method the real dialog opens on, so Details starts closed.
const METHOD = params.get("method") === "clone" ? ("clone" as const) : ("copy" as const);
const UNLINKED = params.has("unlinked");
const MAKE_MAIN = params.get("makemain");
const SOURCE = UNLINKED ? "deskB" : params.has("short") ? "laptopE" : "Laptop E";
const HOLDING = params.get("holding");
const at = (id: string, workspaceRoot: string) => ({ id, workspaceRoot });
// A copy sits at the same place in its umbrella checkout as the project sent from.
const copyIn = (root: string) => `${root}/repositories/acme/specweave`;
const holding =
  HOLDING === "main"
    ? { kind: "main" as const, copy: at("rackF", copyIn("/Users/you/projects/atlas")) }
    : HOLDING === "several" || HOLDING === "several-main"
      ? {
          kind: "several" as const,
          copies: [
            at("a", copyIn("/Users/you/projects/atlas")),
            at("b", copyIn("/Users/you/work/atlas")),
          ],
          mainId: "b",
        }
      : HOLDING === "copy"
        ? {
            kind: "copy" as const,
            copy: at("rackF", copyIn("/Users/you/projects/atlas")),
          }
        : { kind: "none" as const };
function Fixture() {
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<string | null>(HOLDING === "several-main" ? "b" : null);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [moveAsked, setMoveAsked] = useState(params.has("move"));
  const [run, setRun] = useState(0);
  const [intent, setIntent] = useState<"move" | "copy">(moveAsked ? "move" : "copy");
  const [doneOn, setDoneOn] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<string | null>(null);
  // As "Continue the coordinator here" does when the move needs the copy flow: a fresh flow, set to move.
  const askMove = () => {
    setMoveAsked(true);
    setIntent("move");
    setRun((value) => value + 1);
    setOpen(true);
  };
  useEffect(() => {
    window.addEventListener("fixture-move", askMove);
    return () => window.removeEventListener("fixture-move", askMove);
  }, []);
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
        sourceLabel={SOURCE}
        projectTitle={params.has("short") ? "specweave" : "SpecWeave"}
        destinations={[]}
        selected=""
        onSelect={() => {}}
        method={METHOD}
        onMethodChange={() => {}}
        intent={intent}
        copyBusy={busy}
        copyLocked={locked}
        copyDoneOn={doneOn}
        copyDoneAt={doneAt}
        copyTargetLabel={target}
        send={
          HOLDING && target
            ? {
                holding,
                picked,
                onPick: setPicked,
                mainLabel: holding.kind === "main" ? "rackF" : SOURCE,
                otherProject: UNLINKED ? { main: "laptopE" } : null,
                localFiles: params.has("uncommitted") ? Number(params.get("uncommitted")) : null,
              }
            : null
        }
        makeMain={
          MAKE_MAIN && doneOn && !UNLINKED
            ? {
                offer: {
                  key: "rackF:rackF",
                  machine: doneOn,
                  main: SOURCE,
                  kind: MAKE_MAIN === "blocked" ? "blocked" : "move",
                  block: MAKE_MAIN === "blocked" ? "unloaded" : null,
                  reason:
                    MAKE_MAIN === "blocked"
                      ? {
                          text: "Connect {main} first. This window has not opened {project} on {main}, so it cannot hand the coordinator off yet.",
                          values: { machine: doneOn, main: SOURCE, project: "SpecWeave" },
                        }
                      : null,
                  note: null,
                },
                // The page's switch: this dialog steps aside, then the move opens in it.
                run: () => {
                  document.body.dataset.madeMain = "rackF:rackF";
                  setOpen(false);
                  askMove();
                },
              }
            : null
        }
        copyFlow={
          <HandoffFolderCopy
            key={run}
            project={
              {
                id: "source",
                environmentId: "laptopE",
                title: "SpecWeave",
                workspaceRoot:
                  "/Users/you/projects/atlas/repositories/acme/specweave",
              } as never
            }
            coordinatorId={"coordinator" as never}
            sourceLabel={SOURCE}
            method={METHOD}
            machines={MACHINES}
            preferredMachine={(params.has("short") ? "rackF" : "linux") as never}
            // A move names its machine, as "Continue the coordinator here" does.
            machineRequested={moveAsked}
            savedFolder={() =>
              holding.kind === "main" || holding.kind === "copy"
                ? holding.copy.workspaceRoot
                : holding.kind === "several"
                  ? (holding.copies.find((copy) => copy.id === picked)?.workspaceRoot ?? null)
                  : null
            }
            chooseCopyFirst={holding.kind === "several" && picked === null}
            canMove
            uncommittedFiles={params.has("uncommitted") ? Number(params.get("uncommitted")) : null}
            defaultMode={moveAsked ? "copy-and-move" : "copy-only"}
            onChoicesChange={({ mode, machine, done, doneAt }) => {
              setDoneAt(doneAt ?? null);
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
  ) : params.has("motion") ? (
    <MotionScene />
  ) : params.has("toasts") ? (
    <ToastGallery />
  ) : params.has("preview-clarity") ? (
    <PreviewClarity />
  ) : params.has("git") ? (
    <GitFixture />
  ) : (
    <Fixture />
  ),
);
