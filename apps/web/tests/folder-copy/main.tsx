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
 * Copy to another machine… reads it. Main is on m4 (this machine) unless m5 holds it.
 * `?unlinked=1`: opened from m1, whose copy is not linked to the project m5's copy belongs
 * to (Main: m4). `?makemain=1|blocked`: the done screen offers the page's Make main switch.
 * `?move=1`, or a `fixture-move` event: a move asked for with "Make X main".
 */
// `?method=clone`: the method the real dialog opens on, so Details starts closed.
const METHOD = params.get("method") === "clone" ? ("clone" as const) : ("copy" as const);
const UNLINKED = params.has("unlinked");
const MAKE_MAIN = params.get("makemain");
const SOURCE = UNLINKED ? "m1" : params.has("short") ? "m4" : "MacBook M4";
const HOLDING = params.get("holding");
const at = (id: string, workspaceRoot: string) => ({ id, workspaceRoot });
// A copy sits at the same place in its umbrella checkout as the project sent from.
const copyIn = (root: string) => `${root}/repositories/anton-abyzov/specweave`;
const holding =
  HOLDING === "main"
    ? { kind: "main" as const, copy: at("m5", copyIn("/Users/you/Projects/github/specweave-umb")) }
    : HOLDING === "several" || HOLDING === "several-main"
      ? {
          kind: "several" as const,
          copies: [
            at("a", copyIn("/Users/you/Projects/github/specweave-umb")),
            at("b", copyIn("/Users/you/work/specweave-umb")),
          ],
          mainId: "b",
        }
      : HOLDING === "copy"
        ? {
            kind: "copy" as const,
            copy: at("m5", copyIn("/Users/you/Projects/github/specweave-umb")),
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
  useEffect(() => {
    // As "Make X main" does when the move needs the copy flow: a fresh flow, set to move.
    const ask = () => {
      setMoveAsked(true);
      setIntent("move");
      setRun((value) => value + 1);
    };
    window.addEventListener("fixture-move", ask);
    return () => window.removeEventListener("fixture-move", ask);
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
                mainLabel: holding.kind === "main" ? "m5" : SOURCE,
                otherProject: UNLINKED ? { main: "m4" } : null,
                localFiles: params.has("uncommitted") ? Number(params.get("uncommitted")) : null,
              }
            : null
        }
        makeMain={
          MAKE_MAIN && doneOn && !UNLINKED
            ? {
                offer: {
                  key: "m5:m5",
                  machine: doneOn,
                  main: SOURCE,
                  kind: MAKE_MAIN === "blocked" ? "blocked" : "move",
                  reason:
                    MAKE_MAIN === "blocked"
                      ? {
                          text: "Connect {main} first. This window has not loaded main's copy on {main}, so it cannot make {machine} main yet.",
                          values: { machine: doneOn, main: SOURCE },
                        }
                      : null,
                  note: null,
                },
                run: () => {
                  document.body.dataset.madeMain = "m5:m5";
                  setOpen(false);
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
                environmentId: "m4",
                title: "SpecWeave",
                workspaceRoot:
                  "/Users/you/Projects/github/specweave-umb/repositories/anton-abyzov/specweave",
              } as never
            }
            coordinatorId={"coordinator" as never}
            sourceLabel={SOURCE}
            method={METHOD}
            machines={MACHINES}
            preferredMachine={(params.has("short") ? "m5" : "linux") as never}
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
