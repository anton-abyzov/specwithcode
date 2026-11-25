/**
 * A project link hands the joining copy's routines to the kept copy's machine
 * (1472). The owner chose, per routine, in the link review they approved on
 * both machines; that approval is the consent, recorded on each move. The
 * move itself is the runner move (ScheduledTaskTransfer `moveOut`): staged off
 * there, off here, on there once, under one operation id, so both copies are
 * never on together. A fleet grant still never changes another machine's
 * routines: this runs on the machine that holds them, asked by its owner.
 *
 * A move that does not finish leaves the routine paused here and names why; a
 * try again picks a move that was cut off up under its operation id, so the
 * kept machine never turns it on twice.
 */
import {
  type CoordinatorRoutineCopy,
  type EnvironmentId,
  type Project,
  PROJECT_LINK_ROUTINE_SETUP_MAX,
  ProjectLinkError,
  type ProjectLinkMoveRoutineInput,
  type ProjectLinkMoveRoutineResult,
  type ScheduledTask,
  type ScheduledTaskError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { isCoordinatorOwnedRoutine, routineCopyOf } from "./ScheduledTaskCopies.ts";
import type { RoutineRunnerRecord } from "./ScheduledTaskRunnerRecords.ts";
import type { TransferOutcome } from "./ScheduledTaskTransfer.ts";

export interface LinkMoveDeps {
  /** This machine's projects, deleted ones included. */
  readonly projects: Effect.Effect<ReadonlyArray<Project>>;
  readonly selfEnvironmentId: Effect.Effect<string | null>;
  readonly label: (environmentId: string) => Effect.Effect<string | null>;
  readonly routines: Effect.Effect<ReadonlyArray<ScheduledTask>, ScheduledTaskError>;
  readonly record: (taskId: string) => Effect.Effect<RoutineRunnerRecord | null>;
  /** Settles runners with the other machines now, so a just-linked routine can move. */
  readonly settle: Effect.Effect<void>;
  readonly moveOut: (input: {
    readonly task: ScheduledTask;
    readonly target: EnvironmentId;
    readonly targetLabel: string;
    readonly copy: CoordinatorRoutineCopy;
    readonly boundThreadId: string | null;
    readonly adapt?: ((copy: CoordinatorRoutineCopy) => CoordinatorRoutineCopy) | undefined;
    readonly pausedNote?: string | undefined;
    readonly consent?: string | undefined;
    readonly fromPaused?: boolean | undefined;
  }) => Effect.Effect<TransferOutcome>;
  /** Turns a routine off here with `note`, or with null back on; true when done. */
  readonly pauseHere: (taskId: string, note: string | null) => Effect.Effect<boolean>;
  /** Which kept machine a link paused a routine for; cleared by any turn on or off. */
  readonly linkPause: {
    readonly read: (taskId: string) => Effect.Effect<string | null>;
    readonly mark: (taskId: string, target: string) => Effect.Effect<boolean>;
  };
}

const clip = (text: string) => text.slice(0, 500);

/**
 * Shown on this machine's copy from the moment it is off for the move: true
 * while the kept machine's answer is awaited, and after it.
 */
export const linkMovedNote = (targetLabel: string) =>
  clip(
    `Off here for the project link: it runs on ${targetLabel} once ${targetLabel} confirms the move.`,
  );
/** Shown on this machine's copy when the link could not move it. */
export const linkPausedNote = (targetLabel: string) =>
  clip(
    `Paused: the project link could not move it to ${targetLabel}. Try again from the link, or turn it back on here.`,
  );
export const linkLeftOffNote = (targetLabel: string) =>
  clip(`Turned off when this project was linked with ${targetLabel}.`);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with every mention of the folder `from` (or a path inside it) pointed
 * at `to`. A longer folder that only starts with the same name is left alone.
 */
export function rewriteFolder(text: string, from: string, to: string): string {
  const source = from.replace(/[\\/]+$/, "");
  const target = to.replace(/[\\/]+$/, "");
  if (source.length < 2 || source === target) return text;
  // Bounded on both sides: a path that only ends in the folder (another root, a URL) is not it.
  return text.replace(
    new RegExp(`(?<![A-Za-z0-9._~/\\\\-])${escapeRegExp(source)}(?![A-Za-z0-9._-])`, "g"),
    () => target,
  );
}

/** The routine as the kept machine saves it: this copy's folder becomes the kept copy's. */
export const adaptToKept =
  (from: string, to: string | undefined) =>
  (copy: CoordinatorRoutineCopy): CoordinatorRoutineCopy => {
    if (to === undefined) return copy;
    const move = (text: string) => rewriteFolder(text, from, to);
    return {
      ...copy,
      prompt: move(copy.prompt),
      ...(copy.brief == null
        ? {}
        : {
            brief: {
              ...copy.brief,
              inputs: copy.brief.inputs.map((input) => ({
                ...input,
                location: move(input.location),
              })),
              output: copy.brief.output === null ? null : move(copy.brief.output),
            },
          }),
    };
  };

const isUrl = (location: string) => /^https?:\/\//i.test(location.trim());
const insideFolder = (location: string, folder: string | undefined) => {
  if (folder === undefined) return false;
  const root = folder.replace(/[\\/]+$/, "");
  return location === root || location.startsWith(`${root}/`) || location.startsWith(`${root}\\`);
};
const BROWSER_WORDS = /\b(chrome|browser|signed[- ]in|sign in|log ?in)\b/i;

/**
 * What may need setting up on the kept machine before the routine's next run,
 * from its own brief and prompt as they go there. Notes only: none blocks the link.
 */
export function setupNotes(
  copy: Pick<CoordinatorRoutineCopy, "prompt" | "brief">,
  targetLabel: string,
  keptFolder: string | undefined,
): ReadonlyArray<string> {
  const notes: Array<string> = [];
  for (const input of copy.brief?.inputs ?? []) {
    if (isUrl(input.location))
      notes.push(
        `${input.label} (${input.location}): open it once on ${targetLabel}, signed in, in the browser profile this routine uses.`,
      );
    else if (!insideFolder(input.location, keptFolder))
      notes.push(`${input.label} (${input.location}) must be on ${targetLabel} too.`);
  }
  const output = copy.brief?.output ?? null;
  if (output !== null && !isUrl(output) && !insideFolder(output, keptFolder))
    notes.push(`Its output (${output}) is written on ${targetLabel} from now on.`);
  if (notes.length === 0 && BROWSER_WORDS.test(copy.prompt))
    notes.push(
      `Its prompt uses a browser or a sign-in: sign in on ${targetLabel} in the profile it needs.`,
    );
  if (keptFolder === undefined)
    notes.push(
      `${targetLabel} did not record its project folder, so folder names in the prompt were not changed. Check them there.`,
    );
  return notes.slice(0, PROJECT_LINK_ROUTINE_SETUP_MAX).map(clip);
}

/**
 * The kept machine's refusals that it has no grant for this machine, or one with
 * Routines off. Its other refusals (a project or sign-in left out) are shown as said.
 */
const GRANT_REFUSAL = /does not let that machine(?: run work here|'s coordinator manage routines)/;
const grantDetail = (targetLabel: string) =>
  `${targetLabel} does not let this machine move routines there. On ${targetLabel}: turn on Routines for this machine in Settings > Machines > Who can run work here, then choose Try again.`;
/** Every machine of the project must confirm it rests its copy before one moves. */
const unconfirmedDetail = (targetLabel: string) =>
  `${targetLabel} did not confirm it rests its copy of this routine, so it cannot move yet. Check that ${targetLabel} is online and lets this machine run routines there (on ${targetLabel}: Settings > Machines > Who can run work here > Routines), then choose Try again.`;

/** The kept machine's own refusal says "This machine" of itself: named here as that machine. */
const refusedThere = (targetLabel: string, detail: string) =>
  /^This machine/.test(detail)
    ? `${targetLabel}: ${detail.replace(/^This machine/, "That machine")}`
    : detail;

const refuse = (code: ProjectLinkError["code"], detail: string) =>
  Effect.fail(new ProjectLinkError({ code, detail }));

export const makeLinkMove = (deps: LinkMoveDeps) => {
  // One move per routine at a time: a second call (a double Try again, another
  // window) would read the first's open move as cut off and call it off.
  const inFlight = new Set<string>();
  const once = (input: ProjectLinkMoveRoutineInput) =>
    Effect.suspend(() => {
      if (inFlight.has(input.routineId))
        return Effect.succeed<ProjectLinkMoveRoutineResult>({
          routineId: input.routineId,
          outcome: "failed",
          detail: "It is being moved right now. Try again in a moment.",
          setup: [],
        });
      inFlight.add(input.routineId);
      return run(input).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(input.routineId))));
    });
  const run = (
    input: ProjectLinkMoveRoutineInput,
  ): Effect.Effect<ProjectLinkMoveRoutineResult, ProjectLinkError> =>
    Effect.gen(function* () {
      const result = (
        outcome: ProjectLinkMoveRoutineResult["outcome"],
        detail: string,
        setup: ReadonlyArray<string> = [],
      ): ProjectLinkMoveRoutineResult => ({
        routineId: input.routineId,
        outcome,
        detail: clip(detail),
        setup,
      });
      const project = (yield* deps.projects).find(
        (entry) => entry.id === input.projectId && entry.deletedAt === null,
      );
      if (project === undefined)
        return yield* refuse("not_found", "This project is no longer on this machine.");
      const self = yield* deps.selfEnvironmentId;
      const members = project.workspaceSettings?.logicalProject?.members ?? [];
      const kept = members.find(
        (member) => member.environmentId === input.target && member.environmentId !== self,
      );
      const here = members.find((member) => member.environmentId === self);
      if (self === null || kept === undefined || here === undefined)
        return yield* refuse(
          "not_linked",
          "This copy is not linked with that machine's copy. Finish the link first.",
        );
      const listed = yield* deps.routines.pipe(
        Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })),
      );
      const task = listed.find(
        (entry) => entry.id === input.routineId && entry.projectId === project.id,
      );
      if (task === undefined)
        return yield* refuse("not_found", "That routine is no longer in this project here.");
      const targetLabel = (yield* deps.label(input.target)) ?? "the other machine";
      // Never moved: its URL and signing secret are this machine's.
      if (task.schedule.type === "webhook")
        return result(
          "stays",
          "Stays on this machine: a webhook routine's address is this machine's.",
        );
      if (!isCoordinatorOwnedRoutine(task))
        return result("stays", "Stays on this machine: it follows its worker thread.");
      const record = yield* deps.record(task.id);
      if (record?.state === "disarmed") {
        const runner =
          record.runnerEnvironmentId === input.target
            ? targetLabel
            : (record.runnerLabel ?? "another machine");
        // Another machine runs it: this machine neither moves it nor turns it off there.
        if (input.choice === "leave-off")
          return result(
            "stays",
            `Not changed: ${runner} runs it, not this machine. Turn it off in Routines if it should stop.`,
          );
        return record.runnerEnvironmentId === input.target
          ? result("moved", `Runs on ${targetLabel}; off here.`)
          : result("stays", `Stays as it is: ${runner} runs it.`);
      }

      if (input.choice === "leave-off") {
        if (record?.state === "staged" || record?.state === "moving")
          return result("failed", "It is being moved right now. Try again in a moment.");
        if (!task.enabled) return result("left-off", "Off on this machine.");
        return (yield* deps.pauseHere(task.id, linkLeftOffNote(targetLabel)))
          ? result("left-off", "Turned off on this machine.")
          : result("failed", "It could not be turned off here. Turn it off in Routines.");
      }

      const paused = (detail: string) =>
        Effect.gen(function* () {
          // Marked only when it was on, or still carries this link's mark: one its
          // owner turned on or off meanwhile is left as the owner set it.
          const markable = task.enabled || (yield* deps.linkPause.read(task.id)) === input.target;
          if (!markable)
            return result(
              "failed",
              `${detail} It was turned on or off here meanwhile, so it stays as it is now.`,
            );
          const off =
            (yield* deps.pauseHere(task.id, linkPausedNote(targetLabel))) &&
            (yield* deps.linkPause.mark(task.id, input.target));
          return result(
            "failed",
            off
              ? `${detail} It is paused here until it moves.`
              : `${detail} It could not be paused here, so it still runs here.`,
          );
        });

      // Off here: only a routine this link paused for this target moves, and it
      // moves from off, never turned on here first. One its owner turned on or
      // off since carries no mark and is left as the owner set it.
      const fromPaused = !task.enabled;
      if (record?.state !== "moving") {
        if (fromPaused && (yield* deps.linkPause.read(task.id)) !== input.target)
          return result("failed", "It is off on this machine. Turn it on here, then try again.");
        // A copy just linked has no settled runner yet; the move needs one.
        if (record?.state !== "settled") {
          yield* deps.settle;
          if ((yield* deps.record(task.id))?.state !== "settled")
            return yield* paused(unconfirmedDetail(targetLabel));
        }
      }
      const copy = routineCopyOf({ ...task, ownThread: true });
      if (copy === null) return result("stays", "Stays on this machine: it cannot be sent.");
      const moved = yield* deps.moveOut({
        task,
        target: input.target,
        targetLabel,
        copy,
        boundThreadId: null,
        adapt: adaptToKept(project.workspaceRoot, kept.workspaceRoot),
        pausedNote: linkMovedNote(targetLabel),
        consent: `project-link:${here.linkId ?? project.workspaceSettings?.logicalProject?.id ?? "link"}`,
        fromPaused,
      });
      if (moved.kind === "moved")
        return result(
          "moved",
          `Runs on ${targetLabel} now; off here.`,
          setupNotes(
            adaptToKept(project.workspaceRoot, kept.workspaceRoot)(copy),
            targetLabel,
            kept.workspaceRoot,
          ),
        );
      // Off here and the move still open: a try again finishes it under the same id.
      if (moved.offHere) return result("failed", moved.detail);
      return yield* paused(
        GRANT_REFUSAL.test(moved.detail)
          ? grantDetail(targetLabel)
          : refusedThere(targetLabel, moved.detail.replace(/^Stays here:\s*/, "")),
      );
    });
  return once;
};
