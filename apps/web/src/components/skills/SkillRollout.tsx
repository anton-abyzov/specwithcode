/**
 * "Also add on" after an install or update: the same copy, from the same
 * connected repo at the same commit, on other machines over Connect. Every
 * machine starts unticked; each ticked machine's own preview is the review,
 * Save sends only what was reviewed, and each machine gets its own result
 * row and Undo. "Keep updated on these machines" is stored on this machine only.
 */
import {
  AuthEnvironmentMaintainScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ProjectSkillSourceStatus,
  type ProjectSkillsFleetPushInput,
  type ProjectSkillsFleetPushResult,
  type ProjectSkillUpdateOutcome,
} from "@specweave-studio/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useTx } from "../../i18n";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useFleetSkillGithubSupported, useStudioFleet } from "../../studio/fleet";
import { useMachineNickname, useMachineNicknames } from "../../studio/machineNickname";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { SkillControlReason } from "../settings/ProjectSkillReason";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Spinner } from "../ui/spinner";
import {
  placesPhrase,
  retryMachineIds,
  rolloutMachines,
  rolloutResultTone,
  rolloutResultWords,
  rolloutSourceOf,
  savePhrase,
  undoPlanOf,
  withPreviewRefusals,
  type Phrase,
  type RolloutSource,
} from "./SkillRollout.logic";
import { skillCommandErrorText } from "./SkillUpdateOutcome";

type Row = ProjectSkillsFleetPushResult["results"][number];
type Push = (
  input: Omit<ProjectSkillsFleetPushInput, "projectId" | "pin">,
) => Promise<
  | { readonly ok: true; readonly rows: ReadonlyArray<Row> }
  | { readonly ok: false; readonly error: string }
>;

const TONE_CLASS = {
  done: "text-foreground",
  skipped: "text-muted-foreground",
  failed: "text-destructive-foreground",
} as const;

function usePush(environmentId: EnvironmentId, projectId: ProjectId): Push {
  const push = useAtomCommand(projectWorkspace.skillFleetPush, { reportFailure: false });
  return async (input) => {
    const result = await push({ environmentId, input: { ...input, projectId, pin: false } });
    return result._tag === "Success"
      ? { ok: true, rows: result.value.results }
      : { ok: false, error: skillCommandErrorText(result) };
  };
}

const sendOf = (source: RolloutSource) => ({
  skillId: source.skillId,
  version: source.version,
  contentHash: source.contentHash,
  github: source.github,
});

/** Replaces the rows for the machines in `next`, keeping every other machine's row. */
const merged = (rows: ReadonlyArray<Row>, next: ReadonlyArray<Row>) => [
  ...rows.filter((row) => !next.some((entry) => entry.machineId === row.machineId)),
  ...next,
];

export function SkillRollout({
  environmentId,
  projectId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The skill as this machine's lock records it after the install or update. */
  readonly status: ProjectSkillSourceStatus;
}) {
  const tx = useTx();
  const say = (phrase: Phrase) => tx(phrase.text, phrase.values);
  const self = useMachineNickname(environmentId) || tx("this machine");
  const nickname = useMachineNicknames();
  const fleet = useStudioFleet(environmentId);
  // An older server would drop `github` and look the skill up in the registry instead.
  const supported = useFleetSkillGithubSupported(environmentId);
  const canSend = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const canKeep = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const push = usePush(environmentId, projectId);
  const keepCommand = useAtomCommand(projectWorkspace.skillsRolloutKeep, { reportFailure: false });
  const resolved = rolloutSourceOf(status);
  const source = resolved.ok ? resolved.source : null;

  /** Each machine's latest preview: the review, and the fingerprint Save sends back. */
  const [previews, setPreviews] = useState<ReadonlyArray<Row>>([]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [keep, setKeep] = useState(false);
  const [kept, setKept] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rows, setRows] = useState<ReadonlyArray<Row>>([]);
  /** Machines whose row was undone: no second Undo. */
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /** A failed Undo, per machine: the row it tried to undo stays as it was. */
  const [undoErrors, setUndoErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const base = useMemo(
    () => rolloutMachines(fleet.snapshot?.machines ?? [], environmentId, nickname),
    [environmentId, fleet.snapshot, nickname],
  );
  const machines = withPreviewRefusals(base, previews);
  const label = (machineId: string) =>
    machines.find((machine) => machine.machineId === machineId)?.label ?? machineId;
  const tickedMachines = machines.filter(
    (machine) => machine.disabled === null && ticked.has(machine.machineId),
  );
  const tickedNames = tickedMachines.map((machine) => machine.label);

  // The first look: every machine that may get it previews it once, and a
  // stored "Keep updated" record ticks its machines again.
  const probed = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const probeKey = source ? `${source.skillId}@${source.github.commit}:${base.length}` : null;
  useEffect(() => {
    if (
      source === null ||
      probeKey === null ||
      probed.current === probeKey ||
      !canSend ||
      !supported
    )
      return;
    const open = base.filter((machine) => machine.disabled === null);
    if (open.length === 0) return;
    // Runs once per copy and machine list; the answers land even if the page re-renders meanwhile.
    probed.current = probeKey;
    void (async () => {
      setBusy("probe");
      const [answer, records] = await Promise.all([
        push({
          ...sendOf(source),
          preview: true,
          targets: open
            .slice(0, 32)
            .map((machine) => ({ machineId: machine.machineId, scope: "user" })),
        }),
        keepCommand({ environmentId, input: { projectId, operation: "read" } }),
      ]);
      if (!mounted.current) return;
      setBusy(null);
      if (answer.ok) setPreviews(answer.rows);
      else setError(answer.error);
      if (records._tag === "Success") {
        const record = records.value.records.find(
          (entry) =>
            entry.repo.toLowerCase() === source.repo.toLowerCase() &&
            entry.skill === source.skill &&
            entry.scope === "user",
        );
        if (record) {
          setTicked(new Set(record.machineIds));
          setKeep(true);
          setKept(true);
        }
      }
    })();
  }, [base, canSend, environmentId, keepCommand, probeKey, projectId, push, source, supported]);

  if (base.length === 0 || !supported) return null;
  if (source === null)
    return (
      <p className="text-xs text-muted-foreground" data-testid="skill-rollout-unavailable">
        {tx("Also add on")}: {say((resolved as { reason: Phrase }).reason)}
      </p>
    );

  const review = tickedMachines.map((machine) => ({
    machine,
    preview: previews.find((row) => row.machineId === machine.machineId) ?? null,
  }));
  const sendable = review.filter(
    (entry) => entry.preview?.ok === true && entry.preview.expectedHash,
  );
  const permission = canSend ? null : tx("Needs permission to maintain the machines from here.");

  const previewAgain = async (machineIds: ReadonlyArray<string>) => {
    const answer = await push({
      ...sendOf(source),
      preview: true,
      targets: machineIds.map((machineId) => ({ machineId, scope: "user" })),
    });
    if (!answer.ok) {
      setError(answer.error);
      return [];
    }
    setPreviews((previous) => merged(previous, answer.rows));
    return answer.rows;
  };

  const apply = async (targets: ReadonlyArray<Row>) => {
    const sent = targets.filter((row) => row.ok && row.expectedHash);
    const refused = targets.filter((row) => !(row.ok && row.expectedHash));
    let done: ReadonlyArray<Row> = refused;
    if (sent.length > 0) {
      const answer = await push({
        ...sendOf(source),
        targets: sent.map((row) => ({
          machineId: row.machineId,
          scope: "user",
          expectedHash: row.expectedHash!,
        })),
      });
      done = [
        ...refused,
        ...(answer.ok
          ? answer.rows
          : sent.map((row) => ({
              machineId: row.machineId,
              ok: false,
              reason: "install-failed",
              message: answer.error,
            }))),
      ];
    }
    setRows((previous) => merged(previous, done));
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    await apply(
      review.map(
        (entry) =>
          entry.preview ?? {
            machineId: entry.machine.machineId,
            ok: false,
            reason: "install-failed",
            message: tx("No preview from this machine yet."),
          },
      ),
    );
    if (canKeep && (keep || kept)) {
      const result = await keepCommand({
        environmentId,
        input: keep
          ? {
              projectId,
              operation: "set",
              repo: source.repo,
              skill: source.skill,
              scope: "user",
              machineIds: tickedMachines.map((machine) => machine.machineId) as never,
            }
          : {
              projectId,
              operation: "clear",
              repo: source.repo,
              skill: source.skill,
              scope: "user",
            },
      });
      if (result._tag === "Success") setKept(keep);
    }
    setBusy(null);
  };

  const retry = async () => {
    setBusy("retry");
    setError(null);
    const fresh = await previewAgain(retryMachineIds(rows));
    if (fresh.length > 0) await apply(fresh);
    setBusy(null);
  };

  const undo = async (row: Row) => {
    const plan = undoPlanOf(row, source);
    if (plan.kind === "none") return;
    setBusy(`undo:${row.machineId}`);
    setError(null);
    const send = {
      skillId: source.skillId,
      version: plan.version,
      contentHash: plan.contentHash,
      github: plan.github,
      ...(plan.kind === "remove" ? { action: "remove" as const } : {}),
    };
    const target = { machineId: row.machineId, scope: "user" as const };
    const looked = await push({ ...send, preview: true, targets: [target] });
    const preview = looked.ok ? looked.rows[0] : undefined;
    let result: Row;
    if (!looked.ok || preview === undefined)
      result = {
        machineId: row.machineId,
        ok: false,
        reason: "install-failed",
        message: looked.ok ? tx("No answer from this machine.") : looked.error,
      };
    else if (!preview.ok || !preview.expectedHash) result = preview;
    else {
      const answer = await push({
        ...send,
        targets: [{ ...target, expectedHash: preview.expectedHash }],
      });
      result = answer.ok
        ? (answer.rows[0] ?? {
            machineId: row.machineId,
            ok: false,
            reason: "install-failed",
            message: tx("No answer from this machine."),
          })
        : { machineId: row.machineId, ok: false, reason: "install-failed", message: answer.error };
    }
    setUndoErrors((previous) => {
      const next = new Map(previous);
      if (result.ok) next.delete(row.machineId);
      else next.set(row.machineId, say(rolloutResultWords(result)));
      return next;
    });
    if (result.ok) {
      setUndone((previous) => new Set(previous).add(row.machineId));
      setRows((previous) => merged(previous, [result]));
    }
    setBusy(null);
  };

  const failed = retryMachineIds(rows);
  return (
    <section
      aria-label={tx("Also add on")}
      className="space-y-2 rounded-md border bg-muted/30 px-3 py-2"
      data-testid="skill-rollout"
    >
      <p className="text-xs text-foreground" data-testid="skill-rollout-places">
        {say(placesPhrase(self, tickedNames))}
      </p>
      <fieldset className="space-y-1" disabled={busy !== null && busy !== "probe"}>
        <legend className="text-xs font-medium text-muted-foreground">{tx("Also add on")}</legend>
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {machines.map((machine) => (
            <li
              key={machine.machineId}
              data-machine={machine.machineId}
              data-disabled={machine.disabled ? "" : undefined}
            >
              <label className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  aria-label={machine.label}
                  checked={machine.disabled === null && ticked.has(machine.machineId)}
                  disabled={machine.disabled !== null || !canSend}
                  onCheckedChange={(next) => {
                    const updated = new Set(ticked);
                    if (next) updated.add(machine.machineId);
                    else updated.delete(machine.machineId);
                    setTicked(updated);
                  }}
                />
                <span className={machine.disabled ? "text-muted-foreground" : "text-foreground"}>
                  {machine.label}
                </span>
                {machine.disabled ? (
                  <span className="text-muted-foreground">· {say(machine.disabled)}</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {review.length > 0 ? (
        <ul className="space-y-1" aria-label={tx("Review")} data-testid="skill-rollout-review">
          {review.map(({ machine, preview }) => (
            <li key={machine.machineId} data-machine={machine.machineId} className="text-xs">
              <span className="font-medium text-foreground">{machine.label}</span>{" "}
              {preview === null ? (
                <span className="text-muted-foreground">
                  {busy === "probe" ? tx("Checking…") : tx("Not checked yet")}
                </span>
              ) : preview.ok ? (
                <span className="text-muted-foreground">
                  {tx("gets {skill} {version}", { skill: source.skill, version: source.version })}
                  {preview.previous
                    ? ` ${tx("(replaces {version})", { version: preview.previous.version ?? "?" })}`
                    : ""}
                  {preview.via === "npx" ? ` · ${tx("through npx vskill")}` : ""}
                  {preview.files && preview.files.length > 0 ? (
                    <span
                      className="block truncate font-mono text-2xs"
                      title={preview.files.join("\n")}
                    >
                      {preview.files.join(", ")}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-destructive-foreground">
                  {say(rolloutResultWords(preview))}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs">
          <Checkbox
            checked={keep}
            disabled={!canKeep}
            onCheckedChange={(next) => setKeep(next === true)}
          />
          {tx("Keep updated on these machines")}
        </label>
        <span className="flex-1" />
        {review.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            type="button"
            disabled={busy !== null}
            onClick={() => void previewAgain(tickedMachines.map((machine) => machine.machineId))}
          >
            {tx("Check again")}
          </Button>
        ) : null}
        <SkillControlReason reason={permission}>
          <Button
            size="xs"
            type="button"
            disabled={!canSend || busy !== null || sendable.length === 0}
            onClick={() => void save()}
            data-testid="skill-rollout-save"
          >
            {busy === "save" ? <Spinner className="size-3" /> : null}
            {say(savePhrase(self, tickedNames))}
          </Button>
        </SkillControlReason>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul
          className="divide-y rounded-md border bg-background"
          aria-label={tx("Results")}
          data-testid="skill-rollout-results"
        >
          {rows.map((row) => {
            const tone = rolloutResultTone(row);
            const plan = undone.has(row.machineId) ? null : undoPlanOf(row, source);
            return (
              <li
                key={row.machineId}
                data-machine={row.machineId}
                data-tone={tone}
                className="flex flex-wrap items-center gap-2 px-2 py-1 text-xs"
              >
                <span className="font-medium text-foreground">{label(row.machineId)}</span>
                <span className={TONE_CLASS[tone]} role={tone === "failed" ? "alert" : "status"}>
                  {say(rolloutResultWords(row))}
                </span>
                <span className="flex-1" />
                {undoErrors.has(row.machineId) ? (
                  <span
                    role="alert"
                    className="text-destructive-foreground"
                    data-testid="skill-rollout-undo-error"
                  >
                    {tx("Undo failed: {error}", { error: undoErrors.get(row.machineId)! })}
                  </span>
                ) : null}
                {plan && plan.kind !== "none" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void undo(row)}
                  >
                    {busy === `undo:${row.machineId}` ? <Spinner className="size-3" /> : null}
                    {tx("Undo")}
                  </Button>
                ) : plan?.kind === "none" && row.ok && row.removed !== true ? (
                  <span className="text-muted-foreground">{say(plan.reason)}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {failed.length > 0 ? (
        <Button
          size="xs"
          variant="outline"
          type="button"
          disabled={busy !== null}
          onClick={() => void retry()}
        >
          {busy === "retry" ? <Spinner className="size-3" /> : null}
          {tx("Retry failed ({count})", { count: failed.length })}
        </Button>
      ) : null}
    </section>
  );
}

/** "Also add on" under an install or update outcome, for the skill as the lock now records it. */
export function SkillRolloutAfter({
  environmentId,
  projectId,
  outcome,
  statuses,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly outcome: ProjectSkillUpdateOutcome;
  readonly statuses: ReadonlyArray<ProjectSkillSourceStatus>;
}) {
  if (
    outcome.outcome !== "installed" &&
    outcome.outcome !== "updated" &&
    outcome.outcome !== "current"
  )
    return null;
  const status = statuses.find(
    (entry) => entry.skill === outcome.skill && entry.lockScope === "user",
  );
  if (status === undefined) return null;
  return <SkillRollout environmentId={environmentId} projectId={projectId} status={status} />;
}
