import { CheckIcon, ChevronRightIcon, MinusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
  extraItems,
  extraResultLine,
  otherSide,
  runHasWork,
  syncExtras,
  syncFailure,
  syncPlan,
  syncLeftovers,
  syncResultRows,
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
  /** Offline, read only or from before Sync: the picker greys it with this line. */
  readonly blocked: SyncText | null;
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
  readonly extras: readonly ExtraResultLine[];
  readonly extrasFailure: SyncFailure | null;
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
  present: boolean;
  branch: string | null;
  line: StepLine;
  side: SyncSide;
  /** Set on the result screen: whether this repository ended as a synced one does. */
  done?: boolean;
}) {
  const tx = useTx();
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-sync-cell={side} data-tone={line.tone}>
      {/* Narrow windows stack the two machines, so each cell names its own. */}
      <span className="font-medium text-xs sm:hidden">{machine}</span>
      {present ? (
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
    <div className="rounded-lg border border-border" data-sync-repositories="">
      <div
        className={`${GRID} hidden border-border border-b px-3 py-2 font-medium text-muted-foreground text-xs sm:grid`}
      >
        <span>{tx("Repository")}</span>
        <span className="truncate">{names.a}</span>
        <span className="truncate">{names.b}</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.path}
          className={`${GRID} border-border border-b px-3 py-2 last:border-b-0`}
          data-sync-row={row.path}
        >
          <span className="min-w-0 font-medium text-sm wrap-anywhere">{row.name}</span>
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
}: {
  children: ReactNode;
  tone?: "warning" | "plain";
}) {
  return (
    <p
      role="status"
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
      {extras.leftOut.length > 0 || extras.leftOutNotListed > 0 ? (
        <>
          <h3 className="font-medium text-sm">
            {tx("Secrets and files left out on {machine}", { machine })}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {extras.leftOut.map((file) => {
              const id = `${side}:${file.id}`;
              const on = anyway.has(id);
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
                      disabled={busy || !snapshotTicked(file.path)}
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
          <p className="text-muted-foreground text-xs" data-sync-check-note="">
            {tx(
              "Checked by file name, and untracked files by their first 64 KB. Look through the list before you send.",
            )}{" "}
            {extras.leftOut.some((file) => file.sendAnyway)
              ? tx("Send anyway counts once the uncommitted files of that repository are ticked.")
              : null}
          </p>
        </>
      ) : null}
    </section>
  );
}

/** Each extra that was asked for: the branch it arrived as and the next step, or why it stays. */
function ExtraResults({
  side,
  machine,
  result,
}: {
  side: SyncSide;
  machine: string;
  result: SideResult;
}) {
  const tx = useTx();
  if (result.extras.length === 0 && !result.extrasFailure) return null;
  return (
    <section className="flex flex-col gap-2" data-sync-extra-results={side}>
      <h3 className="font-medium text-sm">{tx("Extras from {machine}", { machine })}</h3>
      {result.extrasFailure ? (
        <Notice>
          {tx("The extras from {machine} were not sent.", { machine })}{" "}
          <Words text={result.extrasFailure.line} />
        </Notice>
      ) : null}
      <ul className="flex flex-col gap-2">
        {result.extras.map((line, index) => (
          <li
            // An operation can send the same branch name from two repositories.
            key={`${line.repository}:${line.branch ?? ""}:${index}`}
            className="flex items-start gap-2 text-sm"
            data-sync-extra-result={line.sent ? "sent" : "stays"}
          >
            {line.sent ? (
              <CheckIcon aria-hidden className="mt-1 size-3.5 shrink-0 text-success-foreground" />
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
  targets,
  initialTarget = null,
  onClose,
  onCompare,
  api = projectSyncApi,
}: {
  projectTitle: string;
  /** The machine whose page is shown: the first of the two. */
  shown: SyncMachine;
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
  const target = targets.find((item) => syncMachineKey(item.machine) === targetKey)?.machine;
  const [stage, setStage] = useState<Stage>({ kind: targetKey ? "checking" : "pick" });
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [anyway, setAnyway] = useState<ReadonlySet<string>>(new Set());
  // A later check or a closed dialog makes an earlier answer stale.
  const run = useRef(0);
  useEffect(() => () => void (run.current += 1), []);

  const names = { a: shown.label, b: target?.label ?? "" };
  const machineOf = useCallback(
    (side: SyncSide, other: SyncMachine) => (side === "a" ? shown : other),
    [shown],
  );

  const check = useCallback(
    async (other: SyncMachine) => {
      const id = (run.current += 1);
      setStage({ kind: "checking" });
      setTicked(new Set());
      setAnyway(new Set());
      const read = await Promise.all(
        SIDES.map(async (side) => {
          const machine = machineOf(side, other);
          const fetched = await api.fetch(machine);
          if (!fetched.ok) return { failure: syncFailure(fetched.cause, machine.label) };
          // After the fetch, so "not pushed" is judged against what the remote has now.
          const inventory = await api.inventory(machine);
          return { fetched: fetched.value, inventory, machine };
        }),
      );
      if (id !== run.current) return;
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

  const sync = async (checked: Checked, other: SyncMachine) => {
    const id = (run.current += 1);
    setStage({ kind: "running", checked, step: "git" });
    const ran = await Promise.all(
      SIDES.map(async (side) => {
        const machine = machineOf(side, other);
        const input = syncRunInput(machine.projectId, checked.plan.steps[side]);
        if (!runHasWork(input)) return { results: null, failure: null };
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
    if (id !== run.current) return;
    // Extras go after Git has moved, one machine at a time, each sent by the machine that has them.
    setStage({ kind: "running", checked, step: "extras" });
    const sent: Record<SyncSide, { extras: ExtraResultLine[]; failure: SyncFailure | null }> = {
      a: { extras: [], failure: null },
      b: { extras: [], failure: null },
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
      for (const items of extraItems(inventory, extras, strip(ticked), strip(anyway))) {
        const result = await api.sendExtras(source, to, {
          operationId: randomUUID(),
          items,
        });
        if (!result.ok) {
          sent[side].failure = syncFailure(result.cause, source.label);
          break;
        }
        sent[side].extras.push(
          ...result.value.items.map((item) =>
            extraResultLine(item, {
              project: projectTitle,
              source: source.label,
              target: to.label,
            }),
          ),
        );
      }
    }
    if (id !== run.current) return;
    // The rows of both machines changed: the menu reads them again when it next opens.
    forgetSyncStatus([syncMachineKey(shown), syncMachineKey(other)]);
    const [a, b] = ran;
    setStage({
      kind: "result",
      checked,
      rows: syncResultRows(checked.plan, { a: a ?? null, b: b ?? null }),
      leftovers: syncLeftovers(checked.plan, { a: a ?? null, b: b ?? null }),
      sides: {
        a: { failure: a?.failure ?? null, extras: sent.a.extras, extrasFailure: sent.a.failure },
        b: { failure: b?.failure ?? null, extras: sent.b.extras, extrasFailure: sent.b.failure },
      },
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
  const inSync =
    stage.kind === "result" &&
    stage.rows.every((row) => row.a.done && row.b.done) &&
    SIDES.every(
      (side) =>
        !stage.sides[side].failure &&
        !stage.sides[side].extrasFailure &&
        stage.sides[side].extras.every((line) => line.sent),
    );
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
            {!target
              ? tx("Sync {project}", { project: projectTitle })
              : inSync
                ? tx("{project} is in sync on {source} and {machine}", {
                    project: projectTitle,
                    source: names.a,
                    machine: names.b,
                  })
                : tx("Sync {project}: {source} and {machine}", {
                    project: projectTitle,
                    source: names.a,
                    machine: names.b,
                  })}
          </DialogTitle>
          <DialogDescription>
            {tx(
              "Git first. Each machine fetches from the remote and moves forward, fast-forward only. Nothing is overwritten and nothing is pushed. The coordinator stays where it is.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
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
                      started.current = true;
                      void check(item.machine);
                    }}
                  >
                    <span className="flex min-w-0 flex-col py-1 text-start">
                      <span className="font-medium wrap-anywhere">{item.machine.label}</span>
                      {item.blocked ? (
                        <span className="font-normal text-xs">
                          <Words text={item.blocked} />
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
            <p className="flex items-center gap-2 text-muted-foreground text-sm" role="status">
              <Spinner size="sm" tone="muted" />
              {tx("Fetching on {source} and {machine}…", { source: names.a, machine: names.b })}
            </p>
          ) : null}
          {stage.kind === "failed" ? (
            <div className="flex flex-col gap-2" data-sync-failures="">
              {stage.failures.map((failure) => (
                <Notice key={failure.line.text + (failure.line.values?.machine ?? "")}>
                  <span data-sync-failure={failure.kind}>
                    <Words text={failure.line} />
                  </span>
                </Notice>
              ))}
              <Notice tone="plain">{tx("Nothing was changed on either machine.")}</Notice>
            </div>
          ) : null}
          {checked && target ? (
            <>
              {stage.kind === "running" ? (
                <p className="flex items-center gap-2 text-sm" role="status" data-sync-progress="">
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
                        {tx("{machine} did not run its part.", { machine: names[side] })}{" "}
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
