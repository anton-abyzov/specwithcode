/**
 * The Hand off dialog's plan, read on the source (1390 AC-17, AC-22). The
 * source gathers what each thread is doing, asks the machine with `check`
 * which sign-in it would run each on, weighs what would travel when asked,
 * and builds the plan with `buildHandoffPlan`. Nothing is held, copied or
 * sent: a check names models and account pools, a measure writes a scratch
 * ref it deletes, and the machine asked is told commit ids only.
 *
 * @module handoffPlanRead
 */
// @effect-diagnostics nodeBuiltinImport:off - one UUID per measure's scratch ref.
import * as NodeCrypto from "node:crypto";

import {
  type EnvironmentId,
  HANDOFF_PLAN_MAX_ITEMS,
  type HandoffModeError,
  type HandoffPlanReadInput,
  type HandoffPlanRow,
  type HandoffPlanUsage,
  type HandoffPlanView,
  type HandoffRunEnding,
  isProjectCoordinatorThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
  type ProjectId,
  type ProjectSyncError,
  type ProjectSyncInventoryResult,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { handoffActivity } from "../away/AwayPlanner.ts";
import { gitText } from "../fleet/folderTransfer/git.ts";
import { limitHandoffTrackState, MAX_FINGERPRINTS } from "../orchestration-v2/limitHandoffTrack.ts";
import { providerUsageSummary } from "../usage/providerUsageSummary.ts";
import { repositoryPathFor } from "./bundleGit.ts";
import {
  buildHandoffPlan,
  checkAnswer,
  type HandoffFolderWorkFact,
  type HandoffMeasure,
  type HandoffTargetCheck,
  type HandoffThreadFact,
  HANDOFF_LIMITS,
  measureTravel,
  type PeerCheckRequest,
  type PeerCheckResponse,
} from "./handoffPlan.ts";
import { REVIEW_FAMILY_UNKNOWN, sourceReviewLock } from "./handoffReviewLock.ts";
import type { HandoffDocument } from "./handoffState.ts";

/** A hand off by hand moves the thread, not the messages held behind it. */
export const QUEUE_STAYS = "Its queued messages do not travel in a hand off by hand yet.";
const PROJECT_UNREAD = "Its project could not be read, so it is not known whose work this is.";

/** The most threads one `check` names (its schema). */
const CHECK_BATCH = 100;
const MEASURE_CONCURRENCY = 4;

export interface HandoffPlanReadDeps {
  readonly self: EnvironmentId;
  readonly selfLabel: string;
  readonly shells: Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, HandoffModeError>;
  readonly document: Effect.Effect<HandoffDocument, HandoffModeError>;
  /** Null when the project is not here; a failure when it could not be read. */
  readonly project: (projectId: ProjectId) => Effect.Effect<Project | null, HandoffModeError>;
  /** Every project on this machine, for the folder work of the whole-machine scope. */
  readonly projectIds: Effect.Effect<ReadonlyArray<ProjectId>>;
  readonly peerLabel: (environmentId: EnvironmentId) => Effect.Effect<string>;
  readonly check: (
    environmentId: EnvironmentId,
    request: PeerCheckRequest,
  ) => Effect.Effect<
    PeerCheckResponse,
    { readonly message: string; readonly needsUpdate?: boolean | undefined }
  >;
  /** Which of these commits the machine holds, for the thread's repository. */
  readonly known: (
    environmentId: EnvironmentId,
    input: {
      readonly shell: OrchestrationV2ThreadShell;
      readonly repositoryPath: string;
      readonly candidates: ReadonlyArray<string>;
    },
  ) => Effect.Effect<ReadonlyArray<string>, { readonly message: string }>;
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly settings: Effect.Effect<ServerSettings | null>;
  /** The project's folder work as Sync lists it; null when this machine cannot read any. */
  readonly inventory:
    | ((projectId: ProjectId) => Effect.Effect<ProjectSyncInventoryResult, ProjectSyncError>)
    | null;
  readonly wire: Pick<PeerCheckRequest, "protocolVersion" | "appVersion" | "capabilities">;
}

/** The pending request a thread waits on, as a Stays reason names it. */
export function pendingOf(
  request: OrchestrationV2ThreadShell["pendingRuntimeRequest"] | undefined,
): HandoffThreadFact["pending"] {
  if (request == null) return null;
  switch (request.kind) {
    case "user_input":
    case "dynamic_tool_call":
    case "mcp-elicitation":
      return "question";
    case "auth_refresh":
      return "sign-in";
    default:
      return "approval";
  }
}

/** How the thread's last run ended, as far as the shell says. */
function runEndingOf(
  shell: OrchestrationV2ThreadShell,
  record: HandoffDocument["threads"][string] | undefined,
): HandoffRunEnding {
  if (shell.activeRunId !== null) return "active";
  return record?.checkpoint?.runEnding ?? "none";
}

/** Uncommitted files, or commits on no remote when the folder has one. Throws when Git cannot read it. */
async function holdsUnsaved(cwd: string): Promise<boolean> {
  if ((await gitText(cwd, ["status", "--porcelain"])).trim().length > 0) return true;
  if ((await gitText(cwd, ["remote"])).trim().length === 0) return false;
  return (
    Number((await gitText(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"])).trim()) > 0
  );
}

const describe = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).slice(0, 500) ||
  "Git could not read it.";

/** The folder work of one project from what Sync lists: its branches only here and its uncommitted files. */
export function folderWorkFact(
  projectId: ProjectId,
  title: string,
  inventory: ProjectSyncInventoryResult,
): HandoffFolderWorkFact {
  const broken = inventory.repositories.find((repository) => repository.unreadDetail !== undefined);
  const uncommittedFiles = inventory.repositories.reduce(
    (sum, repository) => sum + repository.changedFiles + repository.untrackedFiles,
    0,
  );
  const branches = inventory.repositories.flatMap((repository) =>
    repository.onlyHere.map((branch) =>
      repository.path === "" ? branch.branch : `${repository.path}:${branch.branch}`,
    ),
  );
  // The snapshot leaves out what is over its own limits; only the file count can be over one here.
  const measure: HandoffMeasure = {
    bytes: 0,
    files: uncommittedFiles,
    over:
      uncommittedFiles > HANDOFF_LIMITS.maxFiles
        ? { limit: "files", count: uncommittedFiles }
        : null,
  };
  return {
    projectId,
    title,
    uncommittedFiles,
    branches,
    brokenFolder: broken === undefined ? null : broken.path === "" ? title : broken.path,
    measure,
  };
}

interface Candidate {
  readonly shell: OrchestrationV2ThreadShell;
  readonly project: Project | null;
  readonly projectUnread: boolean;
  readonly activity: HandoffThreadFact["activity"];
}

export const makeHandoffPlanRead =
  (deps: HandoffPlanReadDeps) =>
  (input: HandoffPlanReadInput): Effect.Effect<HandoffPlanView, HandoffModeError> =>
    Effect.gen(function* () {
      const destination = input.destinationEnvironmentId;
      const label = yield* deps.peerLabel(destination);
      const document = yield* deps.document;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const providers = yield* deps.providers;
      const settings = yield* deps.settings;

      // 1. Which threads are this machine's to hand off, and what each is doing.
      const projects = new Map<ProjectId, { project: Project | null; unread: boolean }>();
      const projectOf = (projectId: ProjectId) =>
        Effect.gen(function* () {
          const known = projects.get(projectId);
          if (known !== undefined) return known;
          const read = yield* deps.project(projectId).pipe(Effect.result);
          const entry =
            read._tag === "Success"
              ? { project: read.success, unread: false }
              : { project: null, unread: true };
          projects.set(projectId, entry);
          return entry;
        });
      const candidates: Array<Candidate> = [];
      for (const shell of yield* deps.shells) {
        if (input.projectId !== null && shell.projectId !== input.projectId) continue;
        const activity = handoffActivity(shell, deps.self);
        if (activity === null) continue;
        const record = document.threads[shell.id];
        if (record?.continuedOn != null || record?.lease?.state === "fenced") continue;
        const { project, unread } = yield* projectOf(shell.projectId);
        if (!unread && project === null) continue;
        if (project !== null && isProjectCoordinatorThreadId(shell.id, project)) continue;
        candidates.push({ shell, project, projectUnread: unread, activity });
      }

      // 2. The source's own accounts per thread, and its track when the project is on tracks.
      const fingerprintsOf = (driver: string) =>
        [
          ...new Set(
            providers
              .filter((provider) => provider.driver === driver)
              .map((provider) => providerUsageSummary(provider, nowMs).accountFingerprint)
              .filter((value): value is string => value !== null),
          ),
        ].slice(0, MAX_FINGERPRINTS);
      const trackOf = (candidate: Candidate) => {
        if (settings === null || candidate.project === null)
          return { track: null, ambiguous: false };
        const rule = resolveProjectSettings(
          settings,
          candidate.project.id,
          candidate.project,
        ).settings;
        const state = limitHandoffTrackState({
          thread: candidate.shell,
          rule,
          providers,
          nowMs,
        });
        if (state.kind === "none") return { track: null, ambiguous: false };
        if (state.kind === "track") return { track: state.track, ambiguous: false };
        // Held: a review keeps its reviewer's track; anything else is not known.
        return sourceReviewLock(candidate.shell).kind !== "none" ||
          candidate.shell.routing?.taskClass === "review"
          ? { track: "review" as const, ambiguous: false }
          : { track: null, ambiguous: true };
      };
      const asked = candidates.filter((candidate) => !candidate.projectUnread);
      const requests = asked.map((candidate) => {
        const driver =
          providers.find(
            (provider) => provider.instanceId === candidate.shell.modelSelection.instanceId,
          )?.driver ?? candidate.shell.modelSelection.instanceId;
        const track = trackOf(candidate);
        return {
          candidate,
          track,
          thread: {
            sourceThreadId: candidate.shell.id,
            sourceProjectId: candidate.shell.projectId,
            modelSelection: candidate.shell.modelSelection,
            track: track.track,
            driverKind: driver.slice(0, 64),
            accountFingerprints: fingerprintsOf(driver),
          },
        };
      });

      // 3. Ask the machine, at most a check's worth of threads at a time.
      const checks = new Map<string, HandoffTargetCheck>();
      let unreachable: string | null = null;
      for (let start = 0; start < requests.length; start += CHECK_BATCH) {
        const chunk = requests.slice(start, start + CHECK_BATCH);
        const answered = yield* deps
          .check(destination, {
            sourceEnvironmentId: deps.self,
            sourceLabel: deps.selfLabel.slice(0, 120),
            ...deps.wire,
            start: "manual",
            thresholdPercent: null,
            threads: chunk.map((entry) => entry.thread),
          })
          .pipe(Effect.result);
        for (const entry of chunk) {
          checks.set(
            entry.thread.sourceThreadId,
            checkAnswer({
              peerLabel: label,
              threadId: entry.thread.sourceThreadId,
              answer:
                answered._tag === "Success"
                  ? { kind: "answered", response: answered.success }
                  : { kind: "failed", error: answered.failure },
            }),
          );
        }
        if (answered._tag === "Failure") unreachable ??= answered.failure.message.slice(0, 500);
      }

      // 4. The folder's state and, when asked, the weight of what would travel.
      const facts = yield* Effect.forEach(
        candidates,
        (candidate): Effect.Effect<HandoffThreadFact> =>
          Effect.gen(function* () {
            const { shell, project } = candidate;
            const cwd = shell.worktreePath ?? project?.workspaceRoot ?? null;
            const folder =
              cwd === null
                ? { unsaved: false, broken: null as string | null }
                : yield* Effect.tryPromise(() => holdsUnsaved(cwd)).pipe(
                    Effect.map((unsaved) => ({ unsaved, broken: null })),
                    Effect.orElseSucceed(() => ({ unsaved: false, broken: cwd })),
                  );
            const check: HandoffTargetCheck = candidate.projectUnread
              ? { kind: "error", message: PROJECT_UNREAD }
              : (checks.get(shell.id) ?? { kind: "skipped" });
            const measure =
              !input.measure || cwd === null || project === null || folder.broken !== null
                ? null
                : yield* Effect.tryPromise(async () => {
                    const repositoryPath = await repositoryPathFor(project.workspaceRoot, cwd);
                    return measureTravel({
                      cwd,
                      threadId: shell.id,
                      operationId: NodeCrypto.randomUUID(),
                      known: (candidatesOf) =>
                        Effect.runPromise(
                          deps.known(destination, {
                            shell,
                            repositoryPath,
                            candidates: candidatesOf,
                          }),
                        ),
                    });
                  }).pipe(Effect.orElseSucceed(() => null));
            const track = requests.find((entry) => entry.candidate === candidate)?.track;
            const review = sourceReviewLock(shell);
            return {
              id: shell.id,
              title: shell.title,
              projectId: shell.projectId,
              personal: isPersonalAssistantProject(project?.workspaceSettings),
              activity: candidate.activity,
              unsaved: folder.unsaved,
              pending: pendingOf(shell.pendingRuntimeRequest),
              runEnding: runEndingOf(shell, document.threads[shell.id]),
              lastTurnEndedAt: null,
              reviewStay: review.kind === "unknown-family" ? REVIEW_FAMILY_UNKNOWN : null,
              worktreeSet: false,
              brokenFolder: folder.broken,
              trackAmbiguous: track?.ambiguous === true,
              check,
              measure,
              usage: null,
            };
          }),
        { concurrency: MEASURE_CONCURRENCY },
      );

      // 5. The project folder work in scope, by hand only.
      const folderWork: Array<HandoffFolderWorkFact> = [];
      if (deps.inventory !== null) {
        const scope =
          input.projectId !== null
            ? [input.projectId]
            : [
                ...new Set([
                  ...candidates.map((candidate) => candidate.shell.projectId),
                  ...(yield* deps.projectIds),
                ]),
              ];
        for (const projectId of scope) {
          const { project } = yield* projectOf(projectId);
          // The personal assistant's folder stays on this machine with it.
          if (project === null || isPersonalAssistantProject(project.workspaceSettings)) continue;
          const title = project.title;
          const listed = yield* deps.inventory(projectId).pipe(Effect.result);
          folderWork.push(
            listed._tag === "Success"
              ? folderWorkFact(projectId, title, listed.success)
              : {
                  projectId,
                  title,
                  uncommittedFiles: 0,
                  branches: [],
                  brokenFolder: project.workspaceRoot,
                  measure: null,
                },
          );
        }
      }

      const plan = buildHandoffPlan({
        start: "manual",
        self: { environmentId: deps.self, label: deps.selfLabel },
        target: { environmentId: destination, label },
        rule: null,
        threads: facts,
        folderWork,
        nowMs,
      });

      const items = plan.items
        // Settled with nothing unsaved: there is nothing to hand off, as the window lists it.
        .filter((item) => item.stay !== "settled")
        .map((item): HandoffPlanRow => {
          const queued = item.group === "queued";
          return {
            kind: item.kind,
            id: item.id,
            title: item.title.slice(0, 500),
            projectId: item.projectId,
            group: item.group,
            ticked: queued ? false : item.ticked,
            canTick: queued ? false : item.canTick,
            disposition: item.disposition,
            stay: item.stay,
            reason: (queued ? QUEUE_STAYS : item.reason)?.slice(0, 1000) ?? null,
          };
        })
        .slice(0, HANDOFF_PLAN_MAX_ITEMS);

      const usage: Array<HandoffPlanUsage> = [];
      for (const check of checks.values()) {
        const evidence = check.kind === "checked" ? check.evidence : null;
        if (evidence === null) continue;
        if (usage.some((entry) => entry.providerName === evidence.providerName)) continue;
        usage.push({
          providerName: evidence.providerName,
          kind: evidence.kind,
          percentLeft: evidence.kind === "different-account" ? evidence.percentLeft : null,
        });
      }

      return {
        destinationEnvironmentId: destination,
        destinationLabel: label.slice(0, 120),
        sourceLabel: deps.selfLabel.slice(0, 120),
        unreachable,
        usage: usage.slice(0, 16),
        items,
      };
    });
