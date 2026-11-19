import { CheckIcon, ChevronRightIcon, CircleHelpIcon, MinusIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useTx } from "../../i18n";
import { cn, randomUUID } from "../../lib/utils";
import { renderRich } from "../../i18n/rich";
import {
  forgetSyncStatus,
  projectSyncApi,
  syncMachineKey,
  type ProjectSyncApi,
  type SyncMachine,
} from "../../studio/projectSync";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import {
  extraBatchLines,
  extraItems,
  extrasRemain,
  extrasSendOutcome,
  statusesProveInSync,
  otherSide,
  runHasWork,
  syncExtras,
  syncFailure,
  syncPlan,
  syncLeftovers,
  syncResultRows,
  syncResultTitle,
  syncRunInput,
  type ExtraResultLine,
  type StepLine,
  type SyncExtras,
  type SyncFailure,
  type SyncPlan,
  type SyncLeftover,
  type SyncResultRow,
  type SyncSide,
  type SyncText,
} from "./projectSyncDialog.logic";
import type {
  ProjectSyncInventoryResult,
  ProjectSyncStepResult,
} from "@specweave-studio/contracts";

/** Another machine that has the project, and why Sync cannot run with it when it cannot. */
export interface SyncTarget {
  readonly machine: SyncMachine;
  /** Offline, read only or from before Sync: why Sync cannot run with it, naming it. */
  readonly blocked: SyncText | null;
  /** The same reason without the machine's name, for a picker row that already shows it. */
  readonly note?: SyncText | null;
}

const SIDES = ["a", "b"] as const;

interface SideCheck {
  readonly inventory: ProjectSyncInventoryResult | null;
  /** Why this machine's extras could not be listed; the Git part still runs. */
  readonly inventoryFailure: SyncFailure | null;
  readonly extras: SyncExtras;
}

interface Checked {
  readonly plan: SyncPlan;
  readonly sides: Readonly<Record<SyncSide, SideCheck>>;
}

interface SideResult {
  /** Why the machine did not run its part; null when it ran or had nothing to do. */
  readonly failure: SyncFailure | null;
  /** Every extra that was asked for, with what is known of it. */
  readonly extras: readonly ExtraResultLine[];
  readonly extrasFailure: SyncFailure | null;
  /** Whether the call that failed had left the machine ("unknown") or never did. */
  readonly extrasOutcome: "unknown" | "not-sent" | null;
}

type Stage =
  | { readonly kind: "pick" }
  | { readonly kind: "checking" }
  | { readonly kind: "failed"; readonly failures: readonly SyncFailure[] }
  | { readonly kind: "plan"; readonly checked: Checked }
  | { readonly kind: "running"; readonly checked: Checked; readonly step: "git" | "extras" }
  | {
      readonly kind: "result";
      readonly checked: Checked;
      readonly rows: readonly SyncResultRow[];
      readonly leftovers: readonly SyncLeftover[];
      readonly sides: Readonly<Record<SyncSide, SideResult>>;
      /** Both machines' statuses, read after the run, match. */
      readonly proven: boolean;
    };

/** A phrase with its values; branch and file names stand in the code font. */
function Words({ text }: { text: SyncText }) {
  const tx = useTx();
  const code = text.code ?? [];
  const plain = Object.fromEntries(
    Object.entries(text.values ?? {}).filter(([name]) => !code.includes(name)),
  );
  const sentence = tx(text.text, plain);
  if (code.length === 0) return <>{sentence}</>;
  return (
    <>
      {renderRich(
        sentence,
        Object.fromEntries(
          code.map((name) => [
            name,
            <code key={name} className="font-mono wrap-anywhere">
              {text.values?.[name] ?? ""}
            </code>,
          ]),
        ),
      )}
    </>
  );
}

const TONE: Record<StepLine["tone"], string> = {
  moves: "text-foreground font-medium",
  done: "text-muted-foreground",
  held: "text-muted-foreground",
  failed: "text-destructive-foreground",
};

/** One repository on one machine: its branch, what Sync does there, and what else is true. */
function Cell({
  machine,
  present,
  branch,
  line,
  side,
  done,
}: {
  machine: string;
  /** Null: a clone was asked for and no answer came, so nobody knows. */
  present: boolean | null;
  branch: string | null;
  line: StepLine;
  side: SyncSide;
  /** Set on the result screen: whether this repository ended as a synced one does. */
  done?: boolean;
}) {
  const tx = useTx();
  return (
    <div
      role="cell"
      className="flex min-w-0 flex-col gap-0.5"
      data-sync-cell={side}
      data-tone={line.tone}
    >
      {/* Narrow windows stack the two machines, so each cell names its own. */}
      <span className="font-medium text-xs sm:hidden">{machine}</span>
      {present === null ? null : present ? (
        branch ? (
          <code className="font-mono text-xs wrap-anywhere">{branch}</code>
        ) : null
      ) : (
        <span className="text-muted-foreground text-xs" data-sync-missing="">
          {tx("Not there")}
        </span>
      )}
      <span className={`flex items-start gap-1 text-xs ${TONE[line.tone]}`} data-sync-sentence="">
        {done === undefined ? null : done ? (
          <CheckIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-success-foreground" />
        ) : (
          <MinusIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
        )}
        <span className="min-w-0 wrap-anywhere">
          <Words text={line.sentence} />
        </span>
      </span>
      {line.facts.map((fact) => (
        <span
          key={fact.text}
          className="text-warning-foreground text-xs wrap-anywhere"
          data-sync-fact=""
        >
          <Words text={fact} />
        </span>
      ))}
      {line.detail ? (
        <span
          className="font-mono text-2xs text-muted-foreground wrap-anywhere"
          data-sync-detail=""
        >
          {line.detail}
        </span>
      ) : null}
    </div>
  );
}

const GRID = "grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)]";

/** Every repository of the project, with a cell per machine. */
function Repositories({
  names,
  rows,
  result,
}: {
  names: Readonly<Record<SyncSide, string>>;
  rows: ReadonlyArray<SyncResultRow | SyncPlan["rows"][number]>;
  result: boolean;
}) {
  const tx = useTx();
  return (
    <div
      role="table"
      aria-label={tx("Repositories")}
      className="rounded-lg border border-border"
      data-sync-repositories=""
    >
      {/* Narrow windows hide this row; each cell then names its machine itself. */}
      <div
        role="row"
        className={`${GRID} hidden border-border border-b px-3 py-2 font-medium text-muted-foreground text-xs sm:grid`}
      >
        <span role="columnheader">{tx("Repository")}</span>
        <span role="columnheader" className="truncate">
          {names.a}
        </span>
        <span role="columnheader" className="truncate">
          {names.b}
        </span>
      </div>
      {rows.map((row) => (
        <div
          key={row.path}
          role="row"
          className={`${GRID} border-border border-b px-3 py-2 last:border-b-0`}
          data-sync-row={row.path}
        >
          <span role="rowheader" className="min-w-0 font-medium text-sm wrap-anywhere">
            {row.name}
          </span>
          {SIDES.map((side) => {
            const cell = row[side];
            return (
              <Cell
                key={side}
                side={side}
                machine={names[side]}
                present={cell.present}
                branch={cell.branch}
                line={cell.line}
                {...(result && "done" in cell ? { done: cell.done } : {})}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Notice({
  children,
  tone = "warning",
  role = "status",
}: {
  children: ReactNode;
  tone?: "warning" | "plain";
  /** "alert" where the stage failed; omitted inside a region that already announces. */
  role?: "status" | "alert";
}) {
  return (
    <p
      role={role}
      className={
        tone === "warning"
          ? "rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
          : "text-muted-foreground text-sm"
      }
      data-sync-notice=""
    >
      {children}
    </p>
  );
}

/** What is only on one machine: each line unticked, and what a snapshot would leave out. */
function Extras({
  side,
  machine,
  check,
  ticked,
  anyway,
  busy,
  onTick,
  onAnyway,
}: {
  side: SyncSide;
  machine: string;
  check: SideCheck;
  ticked: ReadonlySet<string>;
  anyway: ReadonlySet<string>;
  busy: boolean;
  onTick: (id: string, on: boolean) => void;
  onAnyway: (id: string, on: boolean) => void;
}) {
  const tx = useTx();
  const { extras } = check;
  if (check.inventoryFailure)
    return (
      <section className="flex flex-col gap-2" data-sync-extras={side}>
        <h3 className="font-medium text-sm">
          {tx("Only on {machine} · Git does not carry these", { machine })}
        </h3>
        <Notice>
          {tx("Work that is only on {machine} could not be listed.", { machine })}{" "}
          <Words text={check.inventoryFailure.line} />
        </Notice>
      </section>
    );
  if (extras.lines.length === 0 && extras.leftOut.length === 0 && extras.leftOutNotListed === 0)
    return null;
  // "Send anyway" belongs to the uncommitted files of a repository: off until those are ticked.
  const snapshotTicked = (path: string) => ticked.has(`${side}:uncommitted:${path}`);
  const noteId = useId();
  // Uncommitted files are checked before they are sent, so the note stands wherever they can be.
  const canSendFiles = extras.lines.some((line) => line.kind === "uncommitted" && line.tickable);
  const anySendAnyway = extras.leftOut.some((file) => file.sendAnyway);
  const checkNote = (
    <p className="text-muted-foreground text-xs" id={noteId} data-sync-check-note="">
      {tx(
        "Checked by file name, and untracked files by their first 64 KB. Look through the list before you send.",
      )}{" "}
      {anySendAnyway
        ? tx("Send anyway only applies once that repository's uncommitted files are ticked.")
        : null}
    </p>
  );
  const leftOutShown = extras.leftOut.length > 0 || extras.leftOutNotListed > 0;
  return (
    <section className="flex flex-col gap-2" data-sync-extras={side}>
      {extras.lines.length > 0 ? (
        <>
          <h3 className="font-medium text-sm">
            {tx("Only on {machine} · Git does not carry these", { machine })}
          </h3>
          <ul className="flex flex-col gap-2">
            {extras.lines.map((line) => {
              const id = `${side}:${line.id}`;
              const Row = line.tickable ? "label" : "div";
              return (
                <li key={line.id} data-sync-extra={line.kind}>
                  {/* A line that cannot be sent (stashes, branches not listed) has no box. */}
                  <Row
                    className={cn(
                      "flex items-start gap-2 text-sm has-data-disabled:text-muted-foreground",
                      !line.tickable && "text-muted-foreground",
                    )}
                  >
                    <span className="flex h-5 w-4.5 shrink-0 items-center sm:w-4">
                      {line.tickable ? (
                        <Checkbox
                          checked={ticked.has(id)}
                          disabled={busy}
                          onCheckedChange={(on) => onTick(id, on === true)}
                        />
                      ) : null}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="wrap-anywhere">
                        <Words text={line.label} />
                        {line.kind === "not-pushed" || line.kind === "only-here" ? (
                          <span className="text-muted-foreground"> · {line.repository}</span>
                        ) : null}
                      </span>
                      {line.branches.length > 0 ? (
                        <span className="font-mono text-muted-foreground text-xs wrap-anywhere">
                          {line.branches.slice(0, 6).join(", ")}
                          {line.branches.length > 6 ? ", …" : ""}
                        </span>
                      ) : null}
                      {line.helper ? (
                        <span className="text-muted-foreground text-xs">
                          <Words text={line.helper} />
                        </span>
                      ) : null}
                    </span>
                  </Row>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {leftOutShown ? (
        <>
          <h3 className="font-medium text-sm">
            {tx("Secrets and files left out on {machine}", { machine })}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {extras.leftOut.map((file) => {
              const id = `${side}:${file.id}`;
              // Chosen and its repository's uncommitted files ticked: only then is it sent.
              const counts = snapshotTicked(file.path);
              const on = anyway.has(id) && counts;
              return (
                <li
                  key={file.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
                  data-sync-left-out={file.reason}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <code className="font-mono text-xs wrap-anywhere">
                      {file.path === "." ? file.file : `${file.repository}/${file.file}`}
                    </code>
                    <span className="text-muted-foreground text-xs">
                      <Words text={file.label} />
                    </span>
                  </span>
                  {file.sendAnyway ? (
                    <Button
                      size="xs"
                      variant="outline"
                      aria-pressed={on}
                      disabled={busy || !counts}
                      // Off until then, and the note below says why.
                      aria-describedby={counts ? undefined : noteId}
                      title={
                        counts
                          ? undefined
                          : tx("Tick the uncommitted files of {repository} first.", {
                              repository: file.repository,
                            })
                      }
                      data-sync-send-anyway=""
                      onClick={() => onAnyway(id, !on)}
                    >
                      {on ? tx("Will be sent") : tx("Send anyway")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {extras.leftOutNotListed > 0 ? (
            <p className="text-muted-foreground text-xs">
              {extras.leftOutNotListed === 1
                ? tx("1 more file is left out and not listed.")
                : tx("{n} more files are left out and not listed.", {
                    n: extras.leftOutNotListed,
                  })}
            </p>
          ) : null}
        </>
      ) : null}
      {leftOutShown || canSendFiles ? checkNote : null}
    </section>
  );
}

/**
 * Each extra that was asked for: the branch its receipt names and the next step, why it
 * stays, that it was sent and no answer came back, or that it never left.
 */
function ExtraResults({
  side,
  machine,
  target,
  result,
}: {
  side: SyncSide;
  machine: string;
  target: string;
  result: SideResult;
}) {
  const tx = useTx();
  if (result.extras.length === 0 && !result.extrasFailure) return null;
  const answered = result.extras.some((line) => line.state === "sent" || line.state === "stays");
  return (
    <section className="flex flex-col gap-2" data-sync-extra-results={side}>
      <h3 className="font-medium text-sm">{tx("Extras from {machine}", { machine })}</h3>
      {result.extrasFailure ? (
        <Notice>
          <span data-sync-extras-outcome={result.extrasOutcome ?? ""}>
            {result.extrasOutcome === "unknown"
              ? // Sent, and the answer was lost or unreadable: never "not sent", never "sent".
                tx(
                  "{machine} sent extras and no answer came back. They may have arrived: check {target} before sending again.",
                  { machine, target },
                )
              : answered
                ? tx("The rest of the extras from {machine} were not sent.", { machine })
                : tx("The extras from {machine} were not sent.", { machine })}
          </span>{" "}
          <Words text={result.extrasFailure.line} />
        </Notice>
      ) : null}
      <ul className="flex flex-col gap-2">
        {result.extras.map((line, index) => (
          <li
            // An operation can send the same branch name from two repositories.
            key={`${line.repository}:${line.branch ?? ""}:${index}`}
            className="flex items-start gap-2 text-sm"
            data-sync-extra-result={line.state}
          >
            {line.state === "sent" ? (
              <CheckIcon aria-hidden className="mt-1 size-3.5 shrink-0 text-success-foreground" />
            ) : line.state === "unknown" ? (
              <CircleHelpIcon
                aria-hidden
                className="mt-1 size-3.5 shrink-0 text-warning-foreground"
              />
            ) : (
              <MinusIcon aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="wrap-anywhere">
                {line.branch ? (
                  <>
                    <code className="font-mono text-xs">{line.branch}</code>
                    <span className="text-muted-foreground"> · {line.repository}</span>
                  </>
                ) : (
                  tx("Uncommitted files in {repository}", { repository: line.repository })
                )}
                {line.size ? <span className="text-muted-foreground"> · {line.size}</span> : null}
              </span>
              <span className="text-muted-foreground text-xs">
                <Words text={line.sentence} />
              </span>
              {line.facts.map((fact) => (
                <span key={fact.text} className="text-muted-foreground text-xs">
                  <Words text={fact} />
                </span>
              ))}
              {line.detail ? (
                <span
                  className="font-mono text-2xs text-muted-foreground wrap-anywhere"
                  data-sync-extra-detail=""
                >
                  {line.detail}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * "Sync…": brings a project that is on two machines up to date through Git. Each machine
 * fetches from its own remote and fast-forwards, and a missing repository is cloned. The
 * dialog never resets, rebases, merges, stashes, switches a branch, pushes or commits; it
 * has no call that could. Work Git does not carry is listed per machine, unticked, and
 * arrives on the other machine as branches.
 */
export function ProjectSyncDialog({
  projectTitle,
  shown,
  shownBlocked = null,
  targets,
  initialTarget = null,
  onClose,
  onCompare,
  api = projectSyncApi,
}: {
  projectTitle: string;
  /** The machine whose page is shown: the first of the two. */
  shown: SyncMachine;
  /** Why Sync cannot run on the machine shown right now, as the menu says it; null when it can. */
  shownBlocked?: SyncText | null;
  /** The other machines that have the project. With several, the dialog starts with a picker. */
  targets: readonly SyncTarget[];
  initialTarget?: string | null;
  onClose: () => void;
  /** "Compare all files…": the measured folder copy into that machine, the slow path. */
  onCompare: ((target: SyncMachine) => void) | null;
  api?: ProjectSyncApi;
}) {
  const tx = useTx();
  const open = targets.filter((target) => target.blocked === null);
  const [targetKey, setTargetKey] = useState<string | null>(
    () =>
      initialTarget ?? (targets.length === 1 && open[0] ? syncMachineKey(open[0].machine) : null),
  );
  const live = targets.find((item) => syncMachineKey(item.machine) === targetKey);
  // The machine picked stays named when it leaves the list: the dialog then says why it stopped.
  const [picked, setPicked] = useState<SyncMachine | undefined>(live?.machine);
  const target = live?.machine ?? (targetKey ? picked : undefined);
  const [stage, setStage] = useState<Stage>({ kind: targetKey ? "checking" : "pick" });
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [anyway, setAnyway] = useState<ReadonlySet<string>>(new Set());
  // A later check or a closed dialog makes an earlier answer stale.
  const run = useRef(0);
  // Closed, nothing is shown any more. A development build mounts twice: the check the first
  // mount started is still the one to show, so the count is left alone.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const names = { a: shown.label, b: target?.label ?? "" };
  // Sync is a decision about two machines: what the menu knows of either one right now
  // stops it, also after the plan is on screen. A machine that left the list has no project.
  const block: SyncText | null =
    shownBlocked ??
    (target && !live
      ? { text: "{machine} does not have this project.", values: { machine: target.label } }
      : (live?.blocked ?? null));
  const blockKey = block ? `${block.text}\n${JSON.stringify(block.values ?? {})}` : null;
  // The run is an async job: it asks through this before every call it makes.
  const gate = useRef<SyncText | null>(block);
  useEffect(() => {
    gate.current = block;
  });
  const stopped = (line: SyncText): SyncFailure => ({ kind: "blocked", line });
  // The run that is dispatching calls, and the one a block ended. A run is ended once.
  const running = useRef<number | null>(null);
  const halted = useRef<{ readonly id: number; readonly line: SyncText } | null>(null);
  // A plan on screen or a check under way: what a new block takes away.
  const planning = useRef(false);
  useEffect(() => {
    planning.current = stage.kind === "plan" || stage.kind === "checking";
  });
  const machineOf = useCallback(
    (side: SyncSide, other: SyncMachine) => (side === "a" ? shown : other),
    [shown],
  );

  const check = useCallback(
    async (other: SyncMachine) => {
      const id = (run.current += 1);
      setTicked(new Set());
      setAnyway(new Set());
      if (gate.current) {
        setStage({ kind: "failed", failures: [stopped(gate.current)] });
        return;
      }
      setStage({ kind: "checking" });
      const read = await Promise.all(
        SIDES.map(async (side) => {
          const machine = machineOf(side, other);
          const fetched = await api.fetch(machine);
          if (!fetched.ok) return { failure: syncFailure(fetched.cause, machine.label) };
          // A check that was replaced or closed asks for nothing more.
          if (id !== run.current || !alive.current)
            return { failure: stopped(gate.current ?? { text: "Not sent." }) };
          // After the fetch, so "not pushed" is judged against what the remote has now.
          const inventory = await api.inventory(machine);
          return { fetched: fetched.value, inventory, machine };
        }),
      );
      if (id !== run.current || !alive.current) return;
      const [a, b] = read;
      if (!a || !b || "failure" in a || "failure" in b) {
        setStage({
          kind: "failed",
          failures: read.flatMap((item) => ("failure" in item ? [item.failure] : [])),
        });
        return;
      }
      const side = (item: typeof a, source: string, to: string): SideCheck => ({
        inventory: item.inventory.ok ? item.inventory.value : null,
        inventoryFailure: item.inventory.ok ? null : syncFailure(item.inventory.cause, source),
        extras: item.inventory.ok
          ? syncExtras(item.inventory.value, { project: projectTitle, source, target: to })
          : { lines: [], leftOut: [], leftOutNotListed: 0 },
      });
      setStage({
        kind: "plan",
        checked: {
          plan: syncPlan(
            { a: a.fetched, b: b.fetched },
            { project: projectTitle, a: shown.label, b: other.label },
          ),
          sides: {
            a: side(a, shown.label, other.label),
            b: side(b, other.label, shown.label),
          },
        },
      });
    },
    [api, machineOf, projectTitle, shown.label],
  );

  // Opened on one machine: the check starts at once. The dialog always fetches.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !target) return;
    started.current = true;
    void check(target);
  }, [check, target]);

  // A plan on screen is for the two machines as they were allowed then. When either becomes
  // blocked, the plan and its ticks go, a check under way is dropped, and the reason is shown.
  useEffect(() => {
    const line = gate.current;
    if (blockKey === null || !line) return;
    // A run under way ends here for good: a grant that comes back does not revive it.
    if (running.current !== null && halted.current?.id !== running.current)
      halted.current = { id: running.current, line };
    if (!planning.current) return;
    run.current += 1;
    setTicked(new Set());
    setAnyway(new Set());
    setStage({ kind: "failed", failures: [stopped(line)] });
  }, [blockKey]);
  // The machine shown became another one: what was read of the old one is not shown for it.
  const shownKey = syncMachineKey(shown);
  const lastShown = useRef(shownKey);
  useEffect(() => {
    if (lastShown.current === shownKey) return;
    lastShown.current = shownKey;
    if (target) void check(target);
  }, [check, shownKey, target]);

  const sync = async (checked: Checked, other: SyncMachine) => {
    const id = (run.current += 1);
    if (gate.current) {
      setStage({ kind: "failed", failures: [stopped(gate.current)] });
      return;
    }
    running.current = id;
    /**
     * Asked before every call this run makes. "gone": the run was replaced or the dialog
     * closed, and nothing more is dispatched or shown. A sentence: a machine stopped being
     * allowed during this run, which ends it even if the grant has come back since.
     */
    const halt = (): SyncText | "gone" | null => {
      if (id !== run.current || !alive.current) return "gone";
      if (halted.current?.id === id) return halted.current.line;
      if (gate.current) halted.current = { id, line: gate.current };
      return gate.current;
    };
    setStage({ kind: "running", checked, step: "git" });
    const ran = await Promise.all(
      SIDES.map(async (side) => {
        const machine = machineOf(side, other);
        const input = syncRunInput(machine.projectId, checked.plan.steps[side]);
        if (!runHasWork(input)) return { results: null, failure: null };
        // Asked again right before the call: the pair may no longer be allowed.
        const why = halt();
        if (why === "gone") return { results: null, failure: null, sent: false };
        if (why) return { results: null, failure: stopped(why), sent: false };
        const result = await api.run(machine, {
          fastForward: input.fastForward,
          clone: input.clone,
        });
        return result.ok
          ? {
              results: result.value.repositories as readonly ProjectSyncStepResult[],
              failure: null,
            }
          : { results: null, failure: syncFailure(result.cause, machine.label) };
      }),
    );
    if (id !== run.current || !alive.current) return;
    // Extras go after Git has moved, one machine at a time, each sent by the machine that has them.
    setStage({ kind: "running", checked, step: "extras" });
    const sent: Record<
      SyncSide,
      {
        extras: ExtraResultLine[];
        failure: SyncFailure | null;
        outcome: "unknown" | "not-sent" | null;
      }
    > = {
      a: { extras: [], failure: null, outcome: null },
      b: { extras: [], failure: null, outcome: null },
    };
    for (const side of SIDES) {
      const source = machineOf(side, other);
      const to = machineOf(otherSide(side), other);
      const { inventory, extras } = checked.sides[side];
      if (!inventory) continue;
      const strip = (ids: ReadonlySet<string>) =>
        new Set(
          [...ids].filter((item) => item.startsWith(`${side}:`)).map((item) => item.slice(2)),
        );
      const route = { project: projectTitle, source: source.label, target: to.label };
      const calls = extraItems(inventory, extras, strip(ticked), strip(anyway));
      for (const [at, items] of calls.entries()) {
        // Every call is its own decision: this run must still be the one, the dialog open
        // and both machines allowed.
        const why = halt();
        if (why === "gone") return;
        const result = why
          ? null
          : await api.sendExtras(source, to, { operationId: randomUUID(), items });
        if (result?.ok) {
          // An item the reply does not name was sent all the same: it has no receipt.
          sent[side].extras.push(...extraBatchLines(items, result.value.items, route, "unknown"));
          continue;
        }
        const outcome = result ? extrasSendOutcome(result.cause) : "not-sent";
        sent[side].failure = result
          ? syncFailure(result.cause, source.label)
          : stopped(why ?? { text: "Not sent." });
        sent[side].outcome = outcome;
        sent[side].extras.push(...extraBatchLines(items, null, route, outcome));
        // The calls after it were never made.
        for (const later of calls.slice(at + 1))
          sent[side].extras.push(...extraBatchLines(later, null, route, "not-sent"));
        break;
      }
    }
    const ended = halt();
    if (ended === "gone") return;
    // Only what both machines say now can prove they are in sync: a done step does not. A
    // run that was stopped asks nothing more and proves nothing.
    const after = ended
      ? []
      : await Promise.all(SIDES.map((side) => api.status(machineOf(side, other))));
    if (id !== run.current || !alive.current) return;
    running.current = null;
    const [statusA, statusB] = after;
    // The rows of both machines changed: the menu reads them again when it next opens.
    forgetSyncStatus([syncMachineKey(shown), syncMachineKey(other)]);
    const [a, b] = ran;
    const side = (git: typeof a, extras: (typeof sent)[SyncSide]): SideResult => ({
      failure: git?.failure ?? null,
      extras: extras.extras,
      extrasFailure: extras.failure,
      extrasOutcome: extras.outcome,
    });
    setStage({
      kind: "result",
      checked,
      rows: syncResultRows(checked.plan, { a: a ?? null, b: b ?? null }),
      leftovers: syncLeftovers(checked.plan, { a: a ?? null, b: b ?? null }),
      sides: { a: side(a, sent.a), b: side(b, sent.b) },
      proven: statusesProveInSync(
        statusA?.ok ? statusA.value : null,
        statusB?.ok ? statusB.value : null,
        checked.plan.rows.map((row) => row.path),
      ),
    });
  };

  const busy = stage.kind === "checking" || stage.kind === "running";
  const toggle =
    (set: (update: (last: ReadonlySet<string>) => ReadonlySet<string>) => void) =>
    (id: string, on: boolean) =>
      set((last) => {
        const next = new Set(last);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
  const checked = "checked" in stage ? stage.checked : null;
  const anyTicked = ticked.size > 0;
  const sideTicked = (side: SyncSide) =>
    new Set([...ticked].filter((id) => id.startsWith(`${side}:`)).map((id) => id.slice(2)));
  // What the title may claim: "in sync" only when nothing is known to differ any more.
  const outcome =
    stage.kind === "result"
      ? syncResultTitle({
          rows: stage.rows,
          scanLimited: stage.checked.plan.scanLimited.length > 0,
          failed:
            stage.leftovers.length > 0 ||
            SIDES.some(
              (side) =>
                stage.sides[side].failure !== null ||
                stage.sides[side].extrasFailure !== null ||
                stage.sides[side].extras.some((line) => line.state !== "sent"),
            ),
          workRemains: SIDES.some(
            (side) =>
              stage.checked.sides[side].inventoryFailure !== null ||
              extrasRemain(
                stage.checked.sides[side].extras,
                sideTicked(side),
                stage.sides[side].extrasFailure === null,
              ),
          ),
          proven: stage.proven,
        })
      : null;
  // Extras were sent and their answer never came: that is neither sent nor failed.
  const unanswered =
    stage.kind === "result" &&
    SIDES.some((side) => stage.sides[side].extras.some((line) => line.state === "unknown"));
  const pair = { project: projectTitle, source: names.a, machine: names.b };
  const title = !target
    ? tx("Sync {project}", { project: projectTitle })
    : outcome === "in-sync"
      ? tx("{project} is in sync on {source} and {machine}", pair)
      : outcome === "finished"
        ? tx("Sync finished for {project}: {source} and {machine}", pair)
        : tx("Sync {project}: {source} and {machine}", pair);
  // One region that stays, so a screen reader hears each stage and the result once.
  const said =
    stage.kind === "checking"
      ? tx("Fetching on {source} and {machine}…", { source: names.a, machine: names.b })
      : stage.kind === "running"
        ? stage.step === "git"
          ? tx("Syncing {source} and {machine}…", { source: names.a, machine: names.b })
          : tx("Sending the ticked extras…")
        : outcome === "open"
          ? unanswered
            ? tx("Sync ended, and not every answer came back. Each line says what to check.")
            : tx("Sync ended, and not everything was moved or sent. Each repository says why.")
          : outcome
            ? title
            : "";
  // The result and a failure replace what had focus: the title takes it.
  const titleRef = useRef<HTMLSpanElement>(null);
  const ended = stage.kind === "result" || stage.kind === "failed";
  useEffect(() => {
    if (ended) titleRef.current?.focus();
  }, [ended]);
  const compare =
    onCompare && target ? (
      <Button
        variant="outline"
        className="mr-auto"
        disabled={busy}
        data-sync-compare=""
        onClick={() => {
          onCompare(target);
          onClose();
        }}
      >
        {tx("Compare all files…")}
      </Button>
    ) : null;

  return (
    <Dialog open onOpenChange={(next) => !next && stage.kind !== "running" && onClose()}>
      <DialogPopup
        showCloseButton={stage.kind !== "running"}
        className="w-full sm:max-w-2xl"
        data-project-sync={stage.kind}
      >
        <DialogHeader>
          <DialogTitle>
            {/* Focused when the run ends; the words are the title, so no ring is drawn. */}
            <span ref={titleRef} tabIndex={-1} className="outline-none">
              {title}
            </span>
          </DialogTitle>
          <DialogDescription>
            {tx(
              "Git first. Each machine fetches from the remote and moves forward, fast-forward only. Nothing is overwritten and nothing is pushed. The coordinator stays where it is.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="sr-only" role="status" aria-live="polite" data-sync-live="">
            {said}
          </p>
          {stage.kind === "pick" ? (
            <div className="flex flex-col gap-2" role="group" aria-labelledby="project-sync-pick">
              <p className="font-medium text-sm" id="project-sync-pick">
                {tx("Sync {machine} with", { machine: shown.label })}
              </p>
              {targets.map((item) => {
                const key = syncMachineKey(item.machine);
                return (
                  <Button
                    key={key}
                    variant="outline"
                    size="sm-multiline"
                    className="justify-start"
                    disabled={item.blocked !== null}
                    data-sync-target={key}
                    onClick={() => {
                      setTargetKey(key);
                      setPicked(item.machine);
                      started.current = true;
                      void check(item.machine);
                    }}
                  >
                    <span className="flex min-w-0 flex-col py-1 text-start">
                      <span className="font-medium wrap-anywhere">{item.machine.label}</span>
                      {item.blocked ? (
                        <span className="font-normal text-xs">
                          {/* The row names the machine: the reason is said without it. */}
                          <Words text={item.note ?? item.blocked} />
                        </span>
                      ) : null}
                    </span>
                    {item.blocked ? null : <ChevronRightIcon aria-hidden className="ms-auto" />}
                  </Button>
                );
              })}
            </div>
          ) : null}
          {stage.kind === "checking" ? (
            <p className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner size="sm" tone="muted" />
              {tx("Fetching on {source} and {machine}…", { source: names.a, machine: names.b })}
            </p>
          ) : null}
          {stage.kind === "failed" ? (
            <div className="flex flex-col gap-2" data-sync-failures="">
              {stage.failures.map((failure) => (
                <Notice key={failure.line.text + (failure.line.values?.machine ?? "")} role="alert">
                  <span data-sync-failure={failure.kind}>
                    <Words text={failure.line} />
                  </span>
                </Notice>
              ))}
              <Notice tone="plain">{tx("Nothing was moved or sent.")}</Notice>
            </div>
          ) : null}
          {checked && target ? (
            <>
              {stage.kind === "running" ? (
                <p className="flex items-center gap-2 text-sm" data-sync-progress="">
                  <Spinner size="sm" tone="muted" />
                  {stage.step === "git"
                    ? tx("Syncing {source} and {machine}…", { source: names.a, machine: names.b })
                    : tx("Sending the ticked extras…")}
                </p>
              ) : null}
              {stage.kind === "result"
                ? SIDES.map((side) =>
                    stage.sides[side].failure ? (
                      <Notice key={side}>
                        {tx("{machine} did not finish its part of the sync.", {
                          machine: names[side],
                        })}{" "}
                        <Words text={stage.sides[side].failure.line} />
                      </Notice>
                    ) : null,
                  )
                : null}
              <Repositories
                names={names}
                rows={stage.kind === "result" ? stage.rows : checked.plan.rows}
                result={stage.kind === "result"}
              />
              {stage.kind === "result"
                ? stage.leftovers.map((item) => (
                    <Notice key={`${item.side}:${item.path}`}>
                      <span data-sync-leftover={item.side}>
                        {names[item.side]}: <Words text={item.sentence} />
                      </span>
                    </Notice>
                  ))
                : null}
              {checked.plan.scanLimited.map((side) => (
                <Notice key={side} tone="plain">
                  {tx(
                    "Only the top repository of {machine} is listed: its folder is past the scan limits, so the repositories inside it are skipped.",
                    { machine: names[side] },
                  )}
                </Notice>
              ))}
              {stage.kind === "result"
                ? SIDES.map((side) => (
                    <ExtraResults
                      key={side}
                      side={side}
                      machine={names[side]}
                      target={names[otherSide(side)]}
                      result={stage.sides[side]}
                    />
                  ))
                : SIDES.map((side) => (
                    <Extras
                      key={side}
                      side={side}
                      machine={names[side]}
                      check={checked.sides[side]}
                      ticked={ticked}
                      anyway={anyway}
                      busy={busy}
                      onTick={toggle(setTicked)}
                      onAnyway={toggle(setAnyway)}
                    />
                  ))}
              {stage.kind === "plan" && !checked.plan.moves && !anyTicked ? (
                <Notice tone="plain">
                  <span data-sync-idle="">
                    {tx("Nothing to move forward or clone. Tick an extra to send it.")}
                  </span>
                </Notice>
              ) : null}
              {stage.kind !== "result" ? (
                <p className="text-muted-foreground text-xs">
                  {tx(
                    "Files outside Git on either side? Compare all files… is the slow, complete way.",
                  )}
                </p>
              ) : null}
            </>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {stage.kind === "failed" || checked ? compare : null}
          {stage.kind === "result" ? (
            <>
              <Button
                variant="outline"
                data-sync-again=""
                onClick={() => target && void check(target)}
              >
                {tx("Check again")}
              </Button>
              <Button data-sync-done="" onClick={onClose}>
                {tx("Done")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={stage.kind === "running"} onClick={onClose}>
                {tx("Cancel")}
              </Button>
              {stage.kind === "failed" ? (
                <Button data-sync-again="" onClick={() => target && void check(target)}>
                  {tx("Check again")}
                </Button>
              ) : stage.kind === "pick" ? null : (
                <Button
                  data-sync-run=""
                  disabled={stage.kind !== "plan" || (!stage.checked.plan.moves && !anyTicked)}
                  onClick={() => {
                    if (stage.kind === "plan" && target) void sync(stage.checked, target);
                  }}
                >
                  {stage.kind === "running" ? tx("Syncing…") : tx("Sync")}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
