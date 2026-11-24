import { CheckIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  logicalProjectTitle,
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ProjectId,
  type ProjectLinkPreview,
} from "@specweave-studio/contracts";
import { useTx } from "../../i18n";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { useScratchProject } from "../../hooks/useScratchProject";
import { bestLinkCopy, linkCandidateGroups } from "../../studio/linkCandidateGroups";
import {
  defaultKeptSide,
  fingerprintSummary,
  LINK_REFUSAL_WORDS,
  linkIsResuming,
  looksLikeSameProject,
  noteMergeComplete,
  noteMergeRows,
  noteWrites,
  supersededNotes,
  linkAgreement,
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
import { ProjectLinkCandidates, ProjectLinkChooseDescription } from "./ProjectLinkCandidates";
import { useLinkMachines } from "./useLinkMachines";
import {
  LinkRoutineChoices,
  LinkRoutineResults,
  routineRequests,
  type LinkRoutineChoice,
  type LinkRoutineResult,
} from "./ProjectLinkRoutines";
import { forgetLinkRefusal } from "../../studio/linkRefusals";

export interface ProjectLinkTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

type Phase = "choose" | "checking" | "review" | "linking" | "complete";
type Step = "prepare" | "accept" | "commit" | "confirm";
const STEP_TEXT: Record<Step, string> = {
  prepare: "Preparing the machine that keeps its coordinator…",
  accept: "Joining the other machine…",
  commit: "Copying notes and listing both machines…",
  confirm: "Checking that both machines list each other…",
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
  joining = false,
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
  /**
   * "Link X to this project…": the other copy joins this one. This copy keeps main, the
   * choice of side is not offered, and the review opens at once on what the other machine
   * gives up. Linking never changes main.
   */
  readonly joining?: boolean;
  readonly onLinked?: () => void;
}) {
  const tx = useTx();
  const projects = useProjects();
  const machines = useLinkMachines();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const fingerprint = useAtomCommand(projectLink.fingerprint, { reportFailure: false });
  const preview = useAtomCommand(projectLink.preview, { reportFailure: false });
  const prepare = useAtomCommand(projectLink.prepare, { reportFailure: false });
  const accept = useAtomCommand(projectLink.accept, { reportFailure: false });
  const commit = useAtomCommand(projectLink.commit, { reportFailure: false });
  const moveRoutine = useAtomCommand(projectLink.moveRoutine, { reportFailure: false });
  const [phase, setPhase] = useState<Phase>("choose");
  const [step, setStep] = useState<Step | null>(null);
  const [selected, setSelected] = useState("");
  const [compared, setCompared] = useState<Readonly<Record<string, LinkCandidate>>>({});
  // Every folder that could be read has been: only then is "no copy" known and a copy chosen.
  const [scanned, setScanned] = useState(false);
  const [othersOpen, setOthersOpen] = useState<boolean | null>(null);
  const [previews, setPreviews] = useState<{
    here: ProjectLinkPreview;
    there: ProjectLinkPreview;
  } | null>(null);
  const [kept, setKept] = useState<"here" | "there">("here");
  const [choices, setChoices] = useState<Record<string, NoteChoice>>({});
  const [consent, setConsent] = useState(false);
  const [routineChoices, setRoutineChoices] = useState<Record<string, LinkRoutineChoice>>({});
  const [routineResults, setRoutineResults] = useState<Record<string, LinkRoutineResult>>({});
  const [error, setError] = useState<string | null>(null);
  // The commit answered, but reading both sides back did not show the link on both.
  const [unconfirmed, setUnconfirmed] = useState(false);
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
  const namedKey = initialCandidate
    ? `${initialCandidate.environmentId}:${initialCandidate.projectId}`
    : null;
  const groups = linkCandidateGroups({ ranked, project, namedKey });
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
    setUnconfirmed(false);
    setOthersOpen(null);
    setSelected(
      initialCandidate ? `${initialCandidate.environmentId}:${initialCandidate.projectId}` : "",
    );
  }, [open, initialCandidate]);

  // Fingerprints rank the likely copies; any other project can still be chosen and compared.
  useEffect(() => {
    // A closed dialog forgets its read, so the next opening never acts on the last one's.
    setScanned(false);
    if (!open || hereProblem) return;
    let cancelled = false;
    setCompared({});
    void (async () => {
      const own = await fingerprint({
        environmentId: project.environmentId,
        input: { projectId: project.id },
      });
      if (cancelled) return;
      // Nothing can be compared without this folder; the lists then rest on the remotes alone.
      if (own._tag === "Failure") return setScanned(true);
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
      if (!cancelled) setScanned(true);
    })();
    return () => {
      cancelled = true;
    };
    // Candidates change identity on every projects update; a fresh opening rescans.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hereProblem, project.environmentId, project.id]);

  // Once the folders are read, the best copy is selected, unless a caller named one or the
  // person already picked. It is chosen once, so a row never changes under the pointer.
  const best = scanned
    ? bestLinkCopy(groups.copies, (environmentId) => machines.problem(environmentId) === null)
    : null;
  const bestKey = best ? keyOf(best.project) : null;
  useEffect(() => {
    if (!open || !scanned || namedKey !== null || bestKey === null) return;
    setSelected((current) => (current === "" ? bestKey : current));
    // The choice is made when the read finishes; later changes leave the selection alone.
  }, [open, scanned]);

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
      ? tx(LINK_REFUSAL_WORDS[sides.kept.keepRefusal], { machine: sides.keptLabel })
      : sides.joining.joinRefusal && !resuming
        ? tx(LINK_REFUSAL_WORDS[sides.joining.joinRefusal], { machine: sides.joiningLabel })
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
      // A link that stopped with the other copy kept finishes that way; nothing else
      // moves the coordinator away from a project the other machine joins.
      setKept(
        joining && !linkIsResuming(next.there, next.here)
          ? "here"
          : (initialKept ??
              (linkIsResuming(next.here, next.there)
                ? "here"
                : linkIsResuming(next.there, next.here)
                  ? "there"
                  : defaultKeptSide(next.here, next.there))),
      );
      setChoices({});
      setRoutineChoices({});
      setRoutineResults({});
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
      (autoReview || joining) &&
      target &&
      phase === "choose" &&
      !previews &&
      !error &&
      !machineProblem
    )
      void review();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoReview, joining, target?.id, machineProblem]);

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
      const readBack = async () => {
        const [keptSide, joiningSide] = await Promise.all([
          preview({
            environmentId: keptEnvironment,
            input: { projectId: sides.kept.member.projectId },
          }),
          preview({
            environmentId: joiningEnvironment,
            input: { projectId: sides.joining.member.projectId },
          }),
        ]);
        if (keptSide._tag === "Failure") throw squashAtomCommandFailure(keptSide);
        if (joiningSide._tag === "Failure") throw squashAtomCommandFailure(joiningSide);
        return linkAgreement(keptSide.value, joiningSide.value);
      };
      // Trying again after an unconfirmed commit reads both sides first: the steps ran.
      let agreement: ReturnType<typeof linkAgreement> | null = null;
      if (unconfirmed) {
        current = "confirm";
        setStep("confirm");
        agreement = await readBack();
        current = "prepare";
      }
      if (agreement !== "agreed") {
        setStep("prepare");
        const prepared = await prepare({
          environmentId: keptEnvironment,
          input: {
            operationId,
            projectId: sides.kept.member.projectId,
            joining: sides.joining.member,
            // `ready` holds both machines to the equal-coordinators capability.
            equalCoordinators: true,
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
            ...(prepared.value.sharedIcon ? { sharedIcon: prepared.value.sharedIcon } : {}),
            equalCoordinators: true,
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
            superseded: supersededNotes(rows, choices),
          },
        });
        if (committed._tag === "Failure") throw squashAtomCommandFailure(committed);
        // Linked only when both machines say so; one re-read covers a side still writing.
        current = "confirm";
        setStep("confirm");
        agreement = await readBack();
        if (agreement !== "agreed") agreement = await readBack();
      }
      if (agreement !== "agreed") {
        setUnconfirmed(true);
        setError(
          agreement === "both-missing"
            ? tx("Neither {kept} nor {joining} lists the other yet, so they are not linked.", {
                kept: sides.keptLabel,
                joining: sides.joiningLabel,
              })
            : tx("{missing} does not list {other} yet, so they are not linked.", {
                missing: agreement === "kept-missing" ? sides.keptLabel : sides.joiningLabel,
                other: agreement === "kept-missing" ? sides.joiningLabel : sides.keptLabel,
              }),
        );
        setPhase("review");
        return;
      }
      setUnconfirmed(false);
      writePendingOperation(storageKey, null);
      forgetLinkRefusal(
        `${keptEnvironment}:${sides.kept.member.projectId}`,
        `${joiningEnvironment}:${sides.joining.member.projectId}`,
      );
      setPhase("complete");
      onLinked?.();
      // The joining machine moves its routines now that the kept copy lists it.
      void moveRoutines(routineRequests(sides.joining.routines ?? [], routineChoices));
    } catch (cause) {
      const message = failureMessage(cause);
      if (errorCode(cause) === "notes_changed") {
        setError(`${message} Review the notes again.`);
        running.current = false;
        await review();
        return;
      }
      if (current === "confirm") setUnconfirmed(true);
      setError(
        current === "confirm"
          ? `${message} ${tx("Could not read both machines back, so the link is not confirmed.")}`
          : current === "commit"
            ? `${message} ${tx("{joining} has joined the project; retry to finish listing it on {kept}.", { joining: sides.joiningLabel, kept: sides.keptLabel })}`
            : message,
      );
      setPhase("review");
    } finally {
      setStep(null);
      running.current = false;
    }
  };

  /**
   * One call per routine, in turn, on the joining machine: each is its own
   * runner move, and a try again repeats only the one that did not finish.
   */
  const moveRoutines = async (
    requests: ReadonlyArray<{ readonly routineId: string; readonly choice: "move" | "leave-off" }>,
  ) => {
    if (!sides) return;
    const joiningEnvironment = sides.joining.member.environmentId;
    const input = {
      projectId: sides.joining.member.projectId,
      target: sides.kept.member.environmentId,
    };
    setRoutineResults((previous) => ({
      ...previous,
      ...Object.fromEntries(requests.map(({ routineId }) => [routineId, { kind: "running" }])),
    }));
    for (const request of requests) {
      const answer = await moveRoutine({
        environmentId: joiningEnvironment,
        input: { ...input, ...request },
      });
      const result: LinkRoutineResult =
        answer._tag === "Success"
          ? { kind: "answered", result: answer.value }
          : { kind: "unreached", detail: failureMessage(squashAtomCommandFailure(answer)) };
      setRoutineResults((previous) => ({ ...previous, [request.routineId]: result }));
    }
  };

  const busy = phase === "checking" || phase === "linking";
  const complete = phase === "complete";
  // The other copy joins and this one keeps main, unless an earlier link has to finish the other way.
  const joins = joining && target !== undefined && (sides === null || kept === "here");
  return (
    <Dialog open={open} onOpenChange={(value) => !busy && onOpenChange(value)}>
      <DialogPopup showCloseButton={!busy} className="w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {complete
              ? "Projects linked"
              : joins
                ? tx("Link {machine} to this project", { machine: thereLabel })
                : tx("Link with a project on another machine")}
          </DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {complete && sides
              ? tx(
                  "{project} is one project on {main} and {machine}. Each machine keeps its own coordinator.",
                  {
                    project: logicalProjectTitle(project),
                    main: sides.keptLabel,
                    machine: sides.joiningLabel,
                  },
                )
              : joins
                ? tx(
                    "{machine} joins {project}. Each machine keeps its own coordinator: linking moves nothing.",
                    { machine: thereLabel, project: logicalProjectTitle(project) },
                  )
                : null}
            {!complete && !joins && <ProjectLinkChooseDescription project={project} />}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {complete ? (
            <div className="flex items-center gap-3 rounded-lg bg-muted p-4 text-sm" role="status">
              <CheckIcon className="size-5 shrink-0" aria-hidden />
              <span>
                {tx(
                  "Each machine keeps its own coordinator, and the workers on {machine} keep running. To send {machine} work from {main}, choose Allow on {machine}'s card in Settings > Machines.",
                  { machine: sides?.joiningLabel ?? "", main: sides?.keptLabel ?? "" },
                )}
              </span>
            </div>
          ) : sides ? (
            <LinkReview
              sides={sides}
              resuming={resuming}
              joins={joins}
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
              routineChoices={routineChoices}
              onRoutineChoice={(routineId, choice) =>
                setRoutineChoices((previous) => ({ ...previous, [routineId]: choice }))
              }
              disabled={busy}
            />
          ) : (
            <fieldset disabled={busy} className="min-w-0 space-y-2">
              <legend className="mb-2 text-sm font-medium">{tx("Other machine")}</legend>
              {hereProblem ? (
                <p className="text-sm text-muted-foreground">{hereProblem}</p>
              ) : ranked.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {tx(
                    "No project on another connected machine. Add the folder on that machine first, then link it here.",
                  )}
                </p>
              ) : (
                <ProjectLinkCandidates
                  projectTitle={logicalProjectTitle(project)}
                  groups={groups}
                  selected={selected}
                  onSelect={setSelected}
                  othersOpen={othersOpen}
                  onOthersOpen={(next) => {
                    setOthersOpen(next);
                    // A selected row is never hidden: closing the fold drops a pick inside it.
                    if (!next && groups.others.some((item) => keyOf(item.project) === selected))
                      setSelected("");
                  }}
                  scanned={scanned}
                  machineLabel={machines.label}
                  machineProblem={machines.problem}
                />
              )}
            </fieldset>
          )}
          {complete && sides && (
            <LinkRoutineResults
              routines={sides.joining.routines ?? []}
              results={routineResults}
              keptLabel={sides.keptLabel}
              joiningLabel={sides.joiningLabel}
              onRetry={(routineId) => {
                const choice = routineChoices[routineId] === "leave-off" ? "leave-off" : "move";
                void moveRoutines([{ routineId, choice }]);
              }}
            />
          )}
          {error && (
            <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
              {error}
            </p>
          )}
          {busy && (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {phase === "checking"
                ? "Reading both machines…"
                : step
                  ? STEP_TEXT[step]
                  : "Linking…"}
            </p>
          )}
        </DialogPanel>
        {!complete && (
          <DialogFooter buttonOrder="source">
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
                  : unconfirmed
                    ? "Try again"
                    : resuming
                      ? "Finish linking"
                      : error
                        ? "Retry link"
                        : joins
                          ? tx("Link {machine}", { machine: sides.joiningLabel })
                          : `Link, keep coordinator on ${sides.keptLabel}`}
              </Button>
            ) : (
              <Button
                disabled={busy || !target || machineProblem !== null}
                onClick={() => void review()}
              >
                {phase === "checking" ? tx("Checking…") : tx("Review link")}
              </Button>
            )}
          </DialogFooter>
        )}
        {complete && (
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function LinkReview({
  sides,
  resuming,
  joins,
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
  routineChoices,
  onRoutineChoice,
  disabled,
}: {
  readonly sides: {
    readonly kept: ProjectLinkPreview;
    readonly joining: ProjectLinkPreview;
    readonly keptLabel: string;
    readonly joiningLabel: string;
  };
  readonly resuming: boolean;
  /** The other copy joins this project: no choice of side, and the consent names what it gives up. */
  readonly joins: boolean;
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
  readonly routineChoices: Readonly<Record<string, LinkRoutineChoice>>;
  readonly onRoutineChoice: (routineId: string, choice: LinkRoutineChoice) => void;
  readonly disabled: boolean;
}) {
  const activity = (value: string | null) =>
    value
      ? `Coordinator last active ${new Date(value).toLocaleString()}`
      : "No coordinator activity";
  const { keptLabel, joiningLabel } = sides;
  const tx = useTx();
  return (
    <div className="space-y-4 text-sm">
      {joins ? (
        <p data-link-main-stays="">
          {tx(
            "Each machine keeps its own coordinator. To continue {main}'s conversation on {machine}, use Continue here after linking.",
            { main: keptLabel, machine: joiningLabel },
          )}
        </p>
      ) : null}
      <fieldset hidden={joins} disabled={disabled || resuming} className="min-w-0 space-y-2">
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
      <LinkRoutineChoices
        routines={sides.joining.routines ?? []}
        keptLabel={keptLabel}
        joiningLabel={joiningLabel}
        choices={routineChoices}
        onChoice={onRoutineChoice}
        disabled={disabled}
      />
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
        <span className="min-w-0 wrap-anywhere leading-5" data-link-consent="">
          {joins
            ? tx(
                "Link {machine} to this project. {machine} gives up its own goal and instructions: it follows this project's from now on. Each machine keeps its own coordinator, and {machine}'s workers keep running. Files are not copied.",
                { machine: joiningLabel },
              )
            : tx(
                "Make these one project. Each machine keeps its own coordinator, and the workers on both keep running. Files are not copied.",
              )}
        </span>
      </label>
    </div>
  );
}
