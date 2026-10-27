import { CheckIcon, LaptopIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  logicalProjectTitle,
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ProjectId,
  type ProjectLinkPreview,
  type RepositoryFingerprint,
} from "@specweave-studio/contracts";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { useScratchProject } from "../../hooks/useScratchProject";
import {
  defaultKeptSide,
  fingerprintSummary,
  LINK_REFUSAL_TEXT,
  linkIsResuming,
  looksLikeSameProject,
  noteMergeComplete,
  noteMergeRows,
  noteWrites,
  linkCandidates,
  projectLink,
  projectLinkStorageKey,
  rankCandidates,
  readPendingOperation,
  writePendingOperation,
  type LinkCandidate,
  type NoteChoice,
} from "../../studio/projectLink";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Radio, RadioGroup } from "../ui/radio-group";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { useLinkMachines } from "./useLinkMachines";

export interface ProjectLinkTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

type Phase = "choose" | "checking" | "review" | "linking" | "complete";
type Step = "prepare" | "accept" | "commit";
const STEP_TEXT: Record<Step, string> = {
  prepare: "Preparing the copy that keeps its coordinator…",
  accept: "Joining the other copy…",
  commit: "Copying notes and listing both copies…",
};

const keyOf = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;
const groupingKey = (project: Pick<EnvironmentProject, "repositoryIdentity">) =>
  project.repositoryIdentity ? repositoryGroupingKeyOf(project.repositoryIdentity) : null;
const failureMessage = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The link could not finish. Retry it.";
const errorCode = (cause: unknown) =>
  cause && typeof cause === "object" && "code" in cause ? String(cause.code) : null;

/** A joined copy whose coordinator has not listed it yet: only the last step is missing. */

/**
 * Links two copies of one project on different machines. The person picks the
 * other copy and which coordinator stays; nothing links on resemblance alone.
 * The kept machine prepares, the joining machine accepts, the kept machine
 * commits. Every step is idempotent, so a retry reuses the same operation.
 */
export function ProjectLinkDialog({
  open,
  onOpenChange,
  project,
  initialCandidate = null,
  initialKept,
  autoReview = false,
  onLinked,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The copy whose settings are open; the other copy is chosen here. */
  readonly project: EnvironmentProject;
  readonly initialCandidate?: ProjectLinkTarget | null;
  readonly initialKept?: "here" | "there";
  /** Starts at the review, for finishing a link that stopped after its second step. */
  readonly autoReview?: boolean;
  readonly onLinked?: () => void;
}) {
  const projects = useProjects();
  const machines = useLinkMachines();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const fingerprint = useAtomCommand(projectLink.fingerprint, { reportFailure: false });
  const preview = useAtomCommand(projectLink.preview, { reportFailure: false });
  const prepare = useAtomCommand(projectLink.prepare, { reportFailure: false });
  const accept = useAtomCommand(projectLink.accept, { reportFailure: false });
  const commit = useAtomCommand(projectLink.commit, { reportFailure: false });
  const [phase, setPhase] = useState<Phase>("choose");
  const [step, setStep] = useState<Step | null>(null);
  const [selected, setSelected] = useState("");
  const [here, setHere] = useState<RepositoryFingerprint | null>(null);
  const [compared, setCompared] = useState<Readonly<Record<string, LinkCandidate>>>({});
  const [previews, setPreviews] = useState<{
    here: ProjectLinkPreview;
    there: ProjectLinkPreview;
  } | null>(null);
  const [kept, setKept] = useState<"here" | "there">("here");
  const [choices, setChoices] = useState<Record<string, NoteChoice>>({});
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const candidates = useMemo(
    () => linkCandidates(projects, project, scratchWorkspaceRootFor, initialCandidate),
    [projects, project, scratchWorkspaceRootFor, initialCandidate],
  );
  const ranked = rankCandidates(
    candidates.map(
      (item) =>
        compared[keyOf(item)] ?? { project: item, score: null, rootMatches: null, summary: null },
    ),
  );
  const target = candidates.find((item) => keyOf(item) === selected);
  const hereProblem = machines.problem(project.environmentId);
  const hereLabel = machines.label(project.environmentId);
  const thereLabel = target ? machines.label(target.environmentId) : "the other machine";

  // Each opening starts fresh; a suggested or half-linked copy is preselected.
  useEffect(() => {
    if (!open) return;
    setPhase("choose");
    setStep(null);
    setPreviews(null);
    setChoices({});
    setConsent(false);
    setError(null);
    setSelected(
      initialCandidate ? `${initialCandidate.environmentId}:${initialCandidate.projectId}` : "",
    );
  }, [open, initialCandidate]);

  // Fingerprints rank the likely copies; any other project can still be chosen and compared.
  useEffect(() => {
    if (!open || hereProblem) return;
    let cancelled = false;
    void (async () => {
      const own = await fingerprint({
        environmentId: project.environmentId,
        input: { projectId: project.id },
      });
      if (cancelled || own._tag === "Failure") return;
      setHere(own.value.fingerprint);
      const likely = candidates.filter(
        (item) =>
          machines.state(item.environmentId) === "ready" &&
          (looksLikeSameProject(project, item, groupingKey) ||
            (initialCandidate !== null &&
              item.environmentId === initialCandidate.environmentId &&
              item.id === initialCandidate.projectId)),
      );
      for (let index = 0; index < likely.length && !cancelled; index += 3) {
        const batch = likely.slice(index, index + 3);
        const results = await Promise.all(
          batch.map((item) =>
            fingerprint({ environmentId: item.environmentId, input: { projectId: item.id } }),
          ),
        );
        if (cancelled) return;
        setCompared((previous) => {
          const next = { ...previous };
          batch.forEach((item, position) => {
            const result = results[position]!;
            next[keyOf(item)] =
              result._tag === "Success"
                ? {
                    project: item,
                    ...fingerprintSummary(own.value.fingerprint, result.value.fingerprint),
                  }
                : {
                    project: item,
                    score: null,
                    rootMatches: null,
                    summary: "Could not read this folder.",
                  };
          });
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Candidates change identity on every projects update; a fresh opening rescans.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hereProblem, project.environmentId, project.id]);

  const sides = previews
    ? kept === "here"
      ? {
          kept: previews.here,
          joining: previews.there,
          keptLabel: hereLabel,
          joiningLabel: thereLabel,
        }
      : {
          kept: previews.there,
          joining: previews.here,
          keptLabel: thereLabel,
          joiningLabel: hereLabel,
        }
    : null;
  const resuming = sides ? linkIsResuming(sides.kept, sides.joining) : false;
  const rows = useMemo(
    () => (sides ? noteMergeRows(sides.kept.notes, sides.joining.notes) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previews, kept],
  );
  const shownRows = rows.filter((row) => row.kind === "copy" || row.kind === "conflict");
  const match = sides
    ? fingerprintSummary(sides.joining.fingerprint, sides.kept.fingerprint)
    : null;
  const refusal = sides
    ? sides.kept.keepRefusal
      ? LINK_REFUSAL_TEXT[sides.kept.keepRefusal](sides.keptLabel)
      : sides.joining.joinRefusal && !resuming
        ? LINK_REFUSAL_TEXT[sides.joining.joinRefusal](sides.joiningLabel)
        : null
    : null;
  const machineProblem = hereProblem ?? (target ? machines.problem(target.environmentId) : null);
  const ready =
    sides !== null &&
    refusal === null &&
    machineProblem === null &&
    match?.rootMatches === true &&
    noteMergeComplete(rows, choices) &&
    consent;

  const review = async () => {
    if (running.current || !target) return;
    running.current = true;
    setError(null);
    setPhase("checking");
    try {
      const [own, other] = await Promise.all([
        preview({ environmentId: project.environmentId, input: { projectId: project.id } }),
        preview({ environmentId: target.environmentId, input: { projectId: target.id } }),
      ]);
      if (own._tag === "Failure") throw squashAtomCommandFailure(own);
      if (other._tag === "Failure") throw squashAtomCommandFailure(other);
      const next = { here: own.value, there: other.value };
      setPreviews(next);
      setKept(
        initialKept ??
          (linkIsResuming(next.here, next.there)
            ? "here"
            : linkIsResuming(next.there, next.here)
              ? "there"
              : defaultKeptSide(next.here, next.there)),
      );
      setChoices({});
      setPhase("review");
    } catch (cause) {
      setError(failureMessage(cause));
      setPhase(previews ? "review" : "choose");
    } finally {
      running.current = false;
    }
  };

  useEffect(() => {
    if (
      open &&
      autoReview &&
      target &&
      phase === "choose" &&
      !previews &&
      !error &&
      !machineProblem
    )
      void review();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoReview, target?.id, machineProblem]);

  const link = async () => {
    if (running.current || !sides || !ready) return;
    running.current = true;
    setError(null);
    setPhase("linking");
    const keptEnvironment = sides.kept.member.environmentId;
    const joiningEnvironment = sides.joining.member.environmentId;
    const storageKey = projectLinkStorageKey(sides.kept.member, sides.joining.member);
    let current: Step = "prepare";
    try {
      const operationId = readPendingOperation(storageKey) ?? randomUUID();
      // Saved before the first call: an ambiguous answer retries this same operation.
      writePendingOperation(storageKey, operationId);
      setStep("prepare");
      const prepared = await prepare({
        environmentId: keptEnvironment,
        input: {
          operationId,
          projectId: sides.kept.member.projectId,
          joining: sides.joining.member,
        },
      });
      if (prepared._tag === "Failure") throw squashAtomCommandFailure(prepared);
      current = "accept";
      setStep("accept");
      const accepted = await accept({
        environmentId: joiningEnvironment,
        input: {
          operationId,
          projectId: sides.joining.member.projectId,
          kept: prepared.value.kept,
          logicalProject: prepared.value.logicalProject,
          coordinatorBinding: prepared.value.coordinatorBinding,
          keptFingerprint: prepared.value.fingerprint,
        },
      });
      if (accepted._tag === "Failure") throw squashAtomCommandFailure(accepted);
      current = "commit";
      setStep("commit");
      const committed = await commit({
        environmentId: keptEnvironment,
        input: {
          operationId,
          projectId: sides.kept.member.projectId,
          joining: accepted.value.member,
          notes: noteWrites(rows, choices, sides.joiningLabel, sides.kept.notes),
        },
      });
      if (committed._tag === "Failure") throw squashAtomCommandFailure(committed);
      writePendingOperation(storageKey, null);
      setPhase("complete");
      onLinked?.();
    } catch (cause) {
      const message = failureMessage(cause);
      if (errorCode(cause) === "notes_changed") {
        setError(`${message} Review the notes again.`);
        running.current = false;
        await review();
        return;
      }
      setError(
        current === "commit"
          ? `${message} The copy on ${sides.joiningLabel} already defers to ${sides.keptLabel}; retry to finish listing it there.`
          : message,
      );
      setPhase("review");
    } finally {
      setStep(null);
      running.current = false;
    }
  };

  const busy = phase === "checking" || phase === "linking";
  const complete = phase === "complete";
  return (
    <Dialog open={open} onOpenChange={(value) => !busy && onOpenChange(value)}>
      <DialogPopup showCloseButton={!busy} className="w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {complete ? "Projects linked" : "Link with a project on another machine"}
          </DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {complete && sides
              ? `${logicalProjectTitle(project)} is one project on ${sides.keptLabel} and ${sides.joiningLabel}. The coordinator on ${sides.keptLabel} can send work to both copies.`
              : `Pick the copy of ${logicalProjectTitle(project)} on another machine. One coordinator stays; the other copy runs workers.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {complete ? (
            <div className="flex items-center gap-3 rounded-lg bg-muted p-4 text-sm" role="status">
              <CheckIcon className="size-5 shrink-0" aria-hidden />
              <span>
                The coordinator on {sides?.joiningLabel} is now read-only history. Workers there
                keep running. Allow workers on {sides?.joiningLabel} in Settings &gt; Machines to
                send it work.
              </span>
            </div>
          ) : sides ? (
            <LinkReview
              sides={sides}
              resuming={resuming}
              kept={kept}
              onKept={setKept}
              hereLabel={hereLabel}
              thereLabel={thereLabel}
              previews={previews!}
              matchSummary={match?.summary ?? null}
              rootMatches={match?.rootMatches === true}
              refusal={refusal ?? machineProblem}
              rows={shownRows}
              choices={choices}
              onChoice={(name, choice) =>
                setChoices((previous) => ({ ...previous, [name]: choice }))
              }
              consent={consent}
              onConsent={setConsent}
              disabled={busy}
            />
          ) : (
            <fieldset disabled={busy} className="min-w-0 space-y-2">
              <legend className="mb-2 text-sm font-medium">Other copy</legend>
              {hereProblem ? (
                <p className="text-sm text-muted-foreground">{hereProblem}</p>
              ) : ranked.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No project on another connected machine. Add the folder on that machine first,
                  then link it here.
                </p>
              ) : (
                <RadioGroup
                  value={selected}
                  onValueChange={(value) => setSelected(String(value))}
                  aria-label="Other copy"
                  className="gap-2"
                >
                  {ranked.map((candidate) => {
                    const problem = machines.problem(candidate.project.environmentId);
                    const key = keyOf(candidate.project);
                    return (
                      <label
                        key={key}
                        data-slot="link-candidate"
                        className={`grid min-w-0 grid-cols-[1.125rem_1rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg border p-3 ${
                          selected === key ? "border-primary bg-accent/40" : "border-border"
                        } ${problem ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent/40"}`}
                      >
                        <span className="flex h-5 items-center justify-center">
                          <Radio value={key} disabled={problem !== null} />
                        </span>
                        <span className="flex h-5 items-center justify-center">
                          <LaptopIcon className="size-4 shrink-0" aria-hidden />
                        </span>
                        <span className="min-w-0 text-sm leading-5">
                          <span className="block wrap-anywhere font-medium">
                            {logicalProjectTitle(candidate.project)} on{" "}
                            {machines.label(candidate.project.environmentId)}
                          </span>
                          <span className="block break-all text-xs text-muted-foreground">
                            {candidate.project.workspaceRoot}
                          </span>
                          <span className="mt-1 block wrap-anywhere text-xs">
                            {problem ??
                              (candidate.summary
                                ? `${candidate.rootMatches === false ? "Not a copy: " : ""}${candidate.summary}`
                                : here
                                  ? "Compared when you review the link."
                                  : "Reading folders…")}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </RadioGroup>
              )}
            </fieldset>
          )}
          {error && (
            <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
              {error}
            </p>
          )}
          {busy && (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {phase === "checking" ? "Reading both copies…" : step ? STEP_TEXT[step] : "Linking…"}
            </p>
          )}
        </DialogPanel>
        {!complete && (
          <DialogFooter>
            {sides && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setPreviews(null);
                  setConsent(false);
                  setError(null);
                  setPhase("choose");
                }}
              >
                Back
              </Button>
            )}
            {sides ? (
              <Button disabled={busy || !ready} onClick={() => void link()}>
                {phase === "linking"
                  ? "Linking…"
                  : resuming
                    ? "Finish linking"
                    : error
                      ? "Retry link"
                      : `Link, keep coordinator on ${sides.keptLabel}`}
              </Button>
            ) : (
              <Button
                disabled={busy || !target || machineProblem !== null}
                onClick={() => void review()}
              >
                {phase === "checking" ? "Checking…" : "Review link"}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function LinkReview({
  sides,
  resuming,
  kept,
  onKept,
  hereLabel,
  thereLabel,
  previews,
  matchSummary,
  rootMatches,
  refusal,
  rows,
  choices,
  onChoice,
  consent,
  onConsent,
  disabled,
}: {
  readonly sides: {
    readonly kept: ProjectLinkPreview;
    readonly joining: ProjectLinkPreview;
    readonly keptLabel: string;
    readonly joiningLabel: string;
  };
  readonly resuming: boolean;
  readonly kept: "here" | "there";
  readonly onKept: (value: "here" | "there") => void;
  readonly hereLabel: string;
  readonly thereLabel: string;
  readonly previews: { readonly here: ProjectLinkPreview; readonly there: ProjectLinkPreview };
  readonly matchSummary: string | null;
  readonly rootMatches: boolean;
  readonly refusal: string | null;
  readonly rows: ReturnType<typeof noteMergeRows>;
  readonly choices: Readonly<Record<string, NoteChoice>>;
  readonly onChoice: (name: string, choice: NoteChoice) => void;
  readonly consent: boolean;
  readonly onConsent: (value: boolean) => void;
  readonly disabled: boolean;
}) {
  const activity = (value: string | null) =>
    value
      ? `Coordinator last active ${new Date(value).toLocaleString()}`
      : "No coordinator activity";
  const { keptLabel, joiningLabel } = sides;
  return (
    <div className="space-y-4 text-sm">
      <fieldset disabled={disabled || resuming} className="min-w-0 space-y-2">
        <legend className="mb-2 font-medium">Coordinator stays on</legend>
        <RadioGroup
          value={kept}
          onValueChange={(value) => onKept(value === "there" ? "there" : "here")}
          aria-label="Coordinator stays on"
          className="gap-2"
        >
          {(["here", "there"] as const).map((side) => (
            <label
              key={side}
              className={`flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                kept === side ? "border-primary bg-accent/40" : "border-border"
              }`}
            >
              <span className="flex h-5 items-center">
                <Radio value={side} />
              </span>
              <span className="min-w-0 leading-5">
                <span className="block font-medium">
                  {side === "here" ? hereLabel : thereLabel}
                </span>
                <span className="block break-all text-xs text-muted-foreground">
                  {previews[side].workspaceRoot}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {activity(previews[side].lastCoordinatorActivityAt)}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      {matchSummary && (
        <p className={rootMatches ? "text-muted-foreground" : "text-destructive-foreground"}>
          {rootMatches
            ? matchSummary
            : `These folders are not copies of one project. ${matchSummary}`}
        </p>
      )}
      {refusal && (
        <p role="alert" className="wrap-anywhere text-destructive-foreground">
          {refusal}
        </p>
      )}
      <section aria-label="Notes" className="space-y-2">
        <h3 className="font-medium">Notes</h3>
        {rows.length === 0 ? (
          <p className="text-muted-foreground">
            {keptLabel} already has every note from {joiningLabel}.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) =>
              row.kind === "copy" ? (
                <li key={row.name} className="flex justify-between gap-3 rounded-lg border p-2">
                  <span className="min-w-0 break-all">{row.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    Copied to {keptLabel}
                  </span>
                </li>
              ) : (
                <li
                  key={row.name}
                  className="space-y-2 rounded-lg border p-2"
                  data-slot="note-conflict"
                >
                  <span className="block break-all font-medium">{row.name}</span>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(
                      [
                        [keptLabel, row.kept?.content],
                        [joiningLabel, row.joining?.content],
                      ] as const
                    ).map(([label, content]) => (
                      <div key={label} className="min-w-0">
                        <span className="text-xs text-muted-foreground">{label}</span>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                          {content}
                        </pre>
                      </div>
                    ))}
                  </div>
                  <RadioGroup
                    value={choices[row.name] ?? ""}
                    onValueChange={(value) => onChoice(row.name, value as NoteChoice)}
                    aria-label={`Which ${row.name} to keep`}
                    className="flex flex-wrap gap-4"
                  >
                    {(
                      [
                        ["kept", `Keep ${keptLabel}`],
                        ["joining", `Keep ${joiningLabel}`],
                        ["both", "Keep both"],
                      ] as const
                    ).map(([value, label]) => (
                      <label key={value} className="flex cursor-pointer items-center gap-2 text-xs">
                        <Radio value={value} disabled={disabled} />
                        {label}
                      </label>
                    ))}
                  </RadioGroup>
                </li>
              ),
            )}
          </ul>
        )}
        {sides.joining.notesTruncated && (
          <p className="text-xs text-muted-foreground">
            {joiningLabel} has more notes than one link can carry. Only the listed ones are copied.
          </p>
        )}
      </section>
      {(["goal", "instructions"] as const).map((field) =>
        sides.joining[field].trim() && sides.joining[field] !== sides.kept[field] ? (
          <details key={field} className="rounded-lg border p-3">
            <summary className="cursor-pointer font-medium">
              {field === "goal" ? "Goal" : "Instructions"} on {joiningLabel}
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">
              {keptLabel} keeps its own {field}. Copy anything you need from here.
            </p>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
              {sides.joining[field]}
            </pre>
          </details>
        ) : null,
      )}
      <label className="flex cursor-pointer items-start gap-3 py-1">
        <span className="flex h-5 shrink-0 items-center">
          <Checkbox
            checked={consent}
            disabled={disabled}
            onCheckedChange={(value) => onConsent(value === true)}
          />
        </span>
        <span className="min-w-0 wrap-anywhere leading-5">
          Make these one project. The coordinator on {joiningLabel} becomes read-only history and
          its workers keep running; the coordinator on {keptLabel} can send work to both copies.
          Files are not copied.
        </span>
      </label>
    </div>
  );
}
