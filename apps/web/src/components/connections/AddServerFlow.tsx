import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type NativeConnectionApplyInput,
  type NativeConnectionsSnapshot,
  type NativeTool,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";

import { useLocale, useTx } from "../../i18n";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { AddServerPick } from "./AddServerPick";
import {
  AddServerDone,
  AddServerOverlap,
  AddServerReview,
  type MachineResult,
  type MachineReview,
} from "./AddServerReview";
import { AddServerSummary, type OtherMachine } from "./AddServerSummary";
import {
  defaultTools,
  machinePlan,
  OTHER_MACHINE_REASON,
  otherMachineState,
  secretFields,
  toolChoices,
  withSecrets,
  type OtherMachineState,
  type SecretField,
} from "./addServerPlan";
import type { CatalogEntry } from "./serverCatalog";
import { builtInOverlap, SERVER_NAME, type ServerDraft } from "./serverPaste";

/** What one other machine reports about itself while a server is being added. */
interface MachineReport {
  readonly state: OtherMachineState;
  /** Present only when the machine is ready. */
  readonly snapshot: NativeConnectionsSnapshot | null;
}
type Refreshers = Map<EnvironmentId, () => void>;

/**
 * Watches one other machine. Each machine has its own component because the
 * scope and query hooks cannot run in a loop: the number of machines changes,
 * and a changing hook count crashes the page.
 */
function OtherMachineWatch({
  environmentId,
  onReport,
  refreshers,
}: {
  readonly environmentId: EnvironmentId;
  readonly onReport: (environmentId: EnvironmentId, report: MachineReport | null) => void;
  /** How the flow rescans this machine after it wrote there. */
  readonly refreshers: { readonly current: Refreshers };
}) {
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  // All three run every render, so the hook count never depends on a grant.
  const mayRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const mayWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const mayRun = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const permitted = mayRead && mayWrite && mayRun;
  const query = useEnvironmentQuery(
    connected && permitted
      ? projectWorkspace.nativeConnections({ environmentId, input: {} })
      : null,
  );
  const state = otherMachineState({
    connected,
    permitted,
    snapshot: query.data,
    failed: query.error !== null,
  });
  const snapshot = state === "ready" ? query.data : null;
  const { refresh } = query;
  useEffect(() => {
    onReport(environmentId, { state, snapshot });
  }, [environmentId, onReport, snapshot, state]);
  useEffect(() => {
    refreshers.current.set(environmentId, refresh);
  });
  useEffect(
    () => () => {
      onReport(environmentId, null);
      refreshers.current.delete(environmentId);
    },
    [environmentId, onReport, refreshers],
  );
  return null;
}

interface Adding {
  readonly draft: ServerDraft;
  readonly entry: CatalogEntry | null;
  readonly fields: ReadonlyArray<SecretField>;
  readonly tools: ReadonlyArray<NativeTool>;
  /** Other machines ticked under "Also add on". A new add starts with none. */
  readonly machines: ReadonlyArray<EnvironmentId>;
}

type Stage =
  | { readonly step: "pick" }
  | { readonly step: "overlap"; readonly draft: ServerDraft; readonly entry: CatalogEntry | null }
  | { readonly step: "summary" }
  | {
      readonly step: "review";
      readonly final: ServerDraft;
      readonly machines: ReadonlyArray<MachineReview>;
    }
  | {
      readonly step: "done";
      readonly final: ServerDraft;
      readonly results: ReadonlyArray<MachineResult>;
    };

/**
 * Adds one MCP server to the selected machine and, when ticked, to others:
 * paste or pick, a summary in three parts, a review of every machine's files,
 * then a result and an Undo per machine. Nothing is written before Save.
 */
export function AddServerFlow({
  environmentId,
  machine,
  snapshot,
  project,
  onByHand,
  onChanged,
  onAdded,
}: {
  readonly environmentId: EnvironmentId;
  /** The selected machine's name. */
  readonly machine: string;
  readonly snapshot: NativeConnectionsSnapshot;
  /** Shown on a project's page: the add still reaches every project on the machine. */
  readonly project: boolean;
  readonly onByHand: () => void;
  /** A file on the selected machine changed. */
  readonly onChanged: () => void;
  /** The server now on the selected machine through this flow, or null once undone. */
  readonly onAdded: (name: string | null) => void;
}) {
  const tx = useTx();
  const locale = useLocale();
  const apply = useAtomCommand(projectWorkspace.nativeConnectionApply);
  const { environments } = useEnvironments();
  const others = environments.filter((candidate) => candidate.environmentId !== environmentId);
  const [stage, setStage] = useState<Stage>({ step: "pick" });
  const [adding, setAdding] = useState<Adding | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reports, setReports] = useState<ReadonlyMap<EnvironmentId, MachineReport>>(new Map());
  // What a Save reads: the grants and versions as they are then, not as they were at Review.
  const reportsNow = useRef(reports);
  const snapshotNow = useRef(snapshot);
  useEffect(() => {
    reportsNow.current = reports;
    snapshotNow.current = snapshot;
  }, [reports, snapshot]);
  const refreshers = useRef<Refreshers>(new Map());
  const onReport = useCallback((id: EnvironmentId, report: MachineReport | null) => {
    setReports((current) => {
      const before = current.get(id);
      // An unchanged report must not redraw, or the watchers would report again without end.
      // Scans are compared by their time, so a machine that hands out a new object for the
      // same scan cannot start that either.
      const same =
        report === null
          ? before === undefined
          : before?.state === report.state &&
            before.snapshot?.observedAt === report.snapshot?.observedAt;
      if (same) return current;
      const next = new Map(current);
      if (report === null) next.delete(id);
      else next.set(id, report);
      return next;
    });
  }, []);

  // A person on a keyboard or a screen reader lands on each new part of the flow.
  const shown = useRef(false);
  const land = useCallback((node: HTMLDivElement | null) => {
    if (node === null) return;
    if (shown.current) node.focus();
    else shown.current = true;
  }, []);

  // Only a machine that is ready now counts as ticked, so one that stops being
  // ready is never asked, and the page shows it unticked.
  const ready = (id: EnvironmentId) => reports.get(id)?.state === "ready";
  const current: Adding | null = adding && {
    ...adding,
    machines: adding.machines.filter(ready),
  };

  function list(names: ReadonlyArray<string>) {
    try {
      return new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
    } catch {
      return names.join(", ");
    }
  }

  function start(draft: ServerDraft, entry: CatalogEntry | null) {
    setProblem(null);
    setAdding({
      draft,
      entry,
      fields: secretFields(draft),
      tools: defaultTools(toolChoices(snapshot, draft), entry),
      machines: [],
    });
    setStage({ step: "summary" });
  }
  function pick(draft: ServerDraft, entry: CatalogEntry | null) {
    if (builtInOverlap(draft)) setStage({ step: "overlap", draft, entry });
    else start(draft, entry);
  }
  function reset() {
    setAdding(null);
    setProblem(null);
    setStage({ step: "pick" });
  }

  async function send(
    target: EnvironmentId,
    input: NativeConnectionApplyInput,
  ): Promise<
    | { readonly ok: true; readonly value: NativeConnectionsSnapshot }
    | { readonly ok: false; readonly message: string }
  > {
    try {
      const result = await apply({ environmentId: target, input });
      if (result._tag === "Success") return { ok: true, value: result.value };
      const cause = squashAtomCommandFailure(result);
      return {
        ok: false,
        message:
          cause instanceof Error ? cause.message : tx("The machine did not confirm the change."),
      };
    } catch {
      return { ok: false, message: tx("The machine did not confirm the change.") };
    }
  }

  /** The machines of this add, the selected one first, with what each can take. */
  function targets(current: Adding) {
    return [
      {
        environmentId,
        label: machine,
        snapshot: snapshotNow.current as NativeConnectionsSnapshot | null,
      },
      ...current.machines.map((id) => ({
        environmentId: id,
        label: others.find((candidate) => candidate.environmentId === id)?.label ?? id,
        snapshot:
          reportsNow.current.get(id)?.state === "ready"
            ? (reportsNow.current.get(id)?.snapshot ?? null)
            : null,
      })),
    ];
  }

  async function review() {
    const adding = current;
    if (!adding || busy !== null) return;
    const final = withSecrets(adding.draft, adding.fields);
    const choices = toolChoices(snapshot, final);
    const ticked = adding.tools.filter((tool) =>
      choices.some((choice) => choice.tool === tool && choice.blocked === null),
    );
    const empty = adding.fields.find((field) => field.value.trim() === "");
    if (!SERVER_NAME.test(final.name))
      return setProblem(tx("Use a name that starts with a letter: letters, digits, - and _."));
    if (empty)
      return setProblem(tx("Fill in {name}.", { name: adding.entry?.token?.label ?? empty.key }));
    if (ticked.length === 0) return setProblem(tx("Tick at least one tool."));
    setProblem(null);
    setBusy("review");
    const machines: MachineReview[] = [];
    for (const target of targets(adding)) {
      // Not ready any more: it is listed with its reason and never asked.
      if (target.snapshot === null) {
        const state = reportsNow.current.get(target.environmentId)?.state ?? "offline";
        machines.push({
          environmentId: target.environmentId,
          label: target.label,
          tools: [],
          dropped: [],
          files: null,
          refusal: tx(OTHER_MACHINE_REASON[state === "ready" ? "failed" : state], {
            machine: target.label,
          }),
        });
        continue;
      }
      const plan = machinePlan(target.snapshot, final, ticked);
      if (plan.tools.length === 0) {
        machines.push({
          environmentId: target.environmentId,
          label: target.label,
          ...plan,
          files: null,
          refusal: null,
        });
        continue;
      }
      const result = await send(target.environmentId, {
        action: "add",
        name: final.name,
        tools: [...plan.tools],
        server: final.server,
        preview: true,
      });
      machines.push({
        environmentId: target.environmentId,
        label: target.label,
        ...plan,
        files: result.ok ? (result.value.change?.files ?? null) : null,
        refusal: result.ok
          ? result.value.change
            ? null
            : tx("The machine did not confirm the change.")
          : result.message,
      });
    }
    setBusy(null);
    setStage({ step: "review", final, machines });
  }

  /** Whether a machine may still be written to, read at the moment of the write. */
  function stillReady(target: EnvironmentId) {
    if (target === environmentId) return snapshotNow.current.plugins !== undefined;
    return reportsNow.current.get(target)?.state === "ready";
  }

  async function save() {
    if (stage.step !== "review" || busy !== null) return;
    setBusy("save");
    const results: MachineResult[] = [];
    for (const entry of stage.machines) {
      const base = { environmentId: entry.environmentId, label: entry.label, tools: entry.tools };
      if (entry.files === null) {
        results.push({
          ...base,
          state: "skipped",
          changeId: null,
          reason: entry.refusal ?? tx("None of the ticked tools can take it there."),
        });
        continue;
      }
      if (!stillReady(entry.environmentId)) {
        results.push({
          ...base,
          state: "failed",
          changeId: null,
          reason: tx("{machine} can no longer be changed from here.", { machine: entry.label }),
        });
        continue;
      }
      const result = await send(entry.environmentId, {
        action: "add",
        name: stage.final.name,
        tools: [...entry.tools],
        server: stage.final.server,
      });
      results.push({
        ...base,
        state: result.ok ? "added" : "failed",
        changeId: result.ok ? (result.value.change?.id ?? null) : null,
        reason: result.ok ? null : result.message,
      });
      if (entry.environmentId !== environmentId) refreshers.current.get(entry.environmentId)?.();
    }
    setBusy(null);
    setStage({ step: "done", final: stage.final, results });
    if (
      results.some((result) => result.environmentId === environmentId && result.state === "added")
    )
      onAdded(stage.final.name);
    onChanged();
  }

  async function undo(index: number) {
    if (stage.step !== "done" || busy !== null) return;
    const row = stage.results[index];
    if (!row?.changeId || row.state !== "added") return;
    setBusy(`undo:${index}`);
    const result = await send(row.environmentId, { action: "undo", changeId: row.changeId });
    setBusy(null);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setProblem(null);
    // The row says what the last apply did, so a used Undo reads "Undone" from then on.
    setStage({
      ...stage,
      results: stage.results.map((value, position) =>
        position === index ? { ...value, state: "undone" } : value,
      ),
    });
    if (row.environmentId === environmentId) {
      onAdded(null);
      onChanged();
    } else refreshers.current.get(row.environmentId)?.();
  }

  const otherMachines: OtherMachine[] = others.map((candidate) => {
    const state = reports.get(candidate.environmentId)?.state ?? "checking";
    return {
      environmentId: candidate.environmentId,
      label: candidate.label,
      state,
      reason:
        state === "ready" ? null : tx(OTHER_MACHINE_REASON[state], { machine: candidate.label }),
    };
  });

  return (
    <div data-testid="add-server">
      {/* Machines are watched only while a server is being added. */}
      {adding
        ? others.map((candidate) => (
            <OtherMachineWatch
              key={candidate.environmentId}
              environmentId={candidate.environmentId}
              onReport={onReport}
              refreshers={refreshers}
            />
          ))
        : null}
      {/* Keyed by the part shown, so each new part takes the focus once. */}
      <div key={stage.step} ref={land} tabIndex={-1} className="space-y-3 outline-none">
        {stage.step === "pick" ? (
          <AddServerPick snapshot={snapshot} onPick={pick} onByHand={onByHand} />
        ) : stage.step === "overlap" ? (
          <AddServerOverlap
            overlap={builtInOverlap(stage.draft)!}
            onAdd={() => start(stage.draft, stage.entry)}
            onCancel={reset}
          />
        ) : stage.step === "summary" && current ? (
          <AddServerSummary
            machine={machine}
            snapshot={snapshot}
            project={project}
            adding={current}
            others={otherMachines}
            problem={problem}
            pending={busy !== null}
            list={list}
            onChange={(next) => {
              setProblem(null);
              setAdding({ ...current, ...next });
            }}
            onReview={() => void review()}
            onCancel={reset}
            onByHand={() => {
              reset();
              onByHand();
            }}
          />
        ) : stage.step === "review" ? (
          <AddServerReview
            name={stage.final.name}
            machines={stage.machines}
            pending={busy !== null}
            list={list}
            onSave={() => void save()}
            onBack={() => setStage({ step: "summary" })}
          />
        ) : stage.step === "done" && adding ? (
          <AddServerDone
            final={stage.final}
            entry={adding.entry}
            results={stage.results}
            problem={problem}
            busy={busy}
            list={list}
            onUndo={(index) => void undo(index)}
            onClose={reset}
          />
        ) : null}
      </div>
    </div>
  );
}
