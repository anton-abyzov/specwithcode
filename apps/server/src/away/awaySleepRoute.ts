/**
 * Away mode's sleep trigger, this machine's side (1267 T-06, AC-09, D-01, D-02).
 *
 * `POST /api/away/v1/sleep`: the desktop main process says the Mac is about
 * to sleep. When the trigger allows it (a target is set, and "On battery"
 * only fires on battery), this server answers `left` at once and then sends
 * the target an away intent with the grace and the ids that would move. The
 * main process uses the answer to skip the old "move running threads" path,
 * so a sleep never moves work twice. Nothing here depends on a window.
 *
 * `POST /api/away/v1/wake`: the Mac woke or was unlocked. Back before the
 * grace ran out, the intent is cancelled and nothing moved. After it, the
 * session waits for Bring back: the answer tells the main process to show the
 * wake card, or that bringing back started on its own (on power, when set).
 *
 * Both routes accept only this machine's own desktop bearer, like
 * `COORDINATOR_SUSPEND_PATH`.
 */
import {
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_PATH,
  AWAY_PLAN_MAX_ITEMS,
  AWAY_SLEEP_PATH,
  AWAY_WAKE_PATH,
  type AwayConfig,
  type AwayIntentRequest,
  AwaySleepRequest,
  AwaySleepSession,
  type AwaySleepAnswer,
  type AwayWakeAnswer,
  AwayWakeRequest,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type Project,
  type ProjectId,
  type ScheduledTask,
  awayConfigOf,
  isProjectCoordinatorThreadId,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { HandoffMode } from "../handoff/HandoffMode.ts";
import { parseJson, stringifyJson } from "../json.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { coordinatorRoleOf } from "../project/CoordinatorRole.ts";
import { maySuspend } from "../project/CoordinatorSuspendRoute.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { isAwayCandidate } from "./AwayPlanner.ts";
import { type AwayPeerPost, makeAwayPeerPost } from "./awayPeerCall.ts";

const FILE_NAME = "away-sleep.json";
/** The Mac may sleep within seconds; a slower target is not waited for. */
export const AWAY_SLEEP_SEND_TIMEOUT_MS = 4_000;
const MINUTE_MS = 60_000;

// --- decisions, apart from HTTP and storage ------------------------------------

/** Whether this sleep leaves for the target (D-01). Off until a target is set. */
export function sleepTriggerFires(
  config: Pick<AwayConfig, "target" | "sleepTrigger">,
  self: EnvironmentId,
  onBattery: boolean,
): config is Pick<AwayConfig, "sleepTrigger"> & { readonly target: EnvironmentId } {
  if (config.target === null || config.target === self) return false;
  if (config.sleepTrigger === "always") return true;
  return config.sleepTrigger === "on-battery" && onBattery;
}

export interface SleepIntentFacts {
  readonly self: EnvironmentId;
  readonly target: EnvironmentId;
  readonly coordinatorScope: AwayConfig["coordinatorScope"];
  readonly projects: ReadonlyArray<Project>;
  readonly shells: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly tasks: ReadonlyArray<Pick<ScheduledTask, "projectId" | "enabled">>;
}

/**
 * What the intent asks the target for, from local facts only (no probe: the
 * suspend window is too short). Projects: this machine coordinates them, they
 * have a linked copy on the target, they are not the personal assistant and,
 * with the `live` scope, they have work running or queued or an enabled
 * routine. Threads: the live, movable threads the target may continue.
 */
export function sleepIntentIds(
  facts: SleepIntentFacts,
): Pick<AwayIntentRequest, "projectIds" | "threadIds"> {
  const byId = new Map(facts.projects.map((project) => [project.id, project]));
  const busy = new Set<ProjectId>();
  const threadIds: string[] = [];
  for (const shell of facts.shells) {
    if (isAwayCandidate(shell, facts.self) === null) continue;
    const project = byId.get(shell.projectId);
    if (project === undefined || project.deletedAt !== null) continue;
    busy.add(project.id);
    if (isPersonalAssistantProject(project.workspaceSettings)) continue;
    if (isProjectCoordinatorThreadId(shell.id, project)) continue;
    threadIds.push(shell.id);
  }
  for (const task of facts.tasks) if (task.enabled) busy.add(task.projectId);
  const projectIds = facts.projects
    .filter(
      (project) =>
        project.deletedAt === null &&
        coordinatorRoleOf(project).active &&
        !isPersonalAssistantProject(project.workspaceSettings) &&
        project.workspaceSettings?.logicalProject?.members.some(
          (member) => member.environmentId === facts.target,
        ) === true &&
        (facts.coordinatorScope === "all" || busy.has(project.id)),
    )
    .map((project) => project.id);
  return {
    projectIds: projectIds.slice(0, AWAY_PLAN_MAX_ITEMS),
    threadIds: threadIds.slice(0, AWAY_PLAN_MAX_ITEMS),
  };
}

// --- the service -----------------------------------------------------------------

export interface AwaySleepStore {
  readonly read: Effect.Effect<AwaySleepSession | null>;
  readonly write: (next: AwaySleepSession | null) => Effect.Effect<void>;
}

export const memorySleepStore = (
  initial: AwaySleepSession | null = null,
): AwaySleepStore & { readonly current: () => AwaySleepSession | null } => {
  let held = initial;
  return {
    read: Effect.sync(() => held),
    write: (next) => Effect.sync(() => void (held = next)),
    current: () => held,
  };
};

export interface AwaySleepDeps {
  readonly self: EnvironmentId;
  readonly store: AwaySleepStore;
  readonly config: Effect.Effect<AwayConfig>;
  readonly ids: (
    config: AwayConfig & { readonly target: EnvironmentId },
  ) => Effect.Effect<Pick<AwayIntentRequest, "projectIds" | "threadIds">>;
  readonly post: AwayPeerPost;
}

export interface AwaySleepDecision {
  readonly answer: AwaySleepAnswer;
  /** Sends the intent and records the outcome; run it after answering. Never fails. */
  readonly send: Effect.Effect<void>;
}

export interface AwaySleepShape {
  readonly sleep: (request: AwaySleepRequest) => Effect.Effect<AwaySleepDecision>;
  readonly wake: (request: AwayWakeRequest) => Effect.Effect<AwayWakeAnswer>;
  /** The lid-close session, for the wake card and the Away summary. */
  readonly session: Effect.Effect<AwaySleepSession | null>;
  /** Bring back finished, or the user dismissed the card. */
  readonly clear: Effect.Effect<void>;
  /**
   * Registers what "Bring back automatically on power" runs (the Away runner's
   * bring back). Without one, waking on power prompts instead.
   */
  readonly onAutoBringBack: (handler: Effect.Effect<void>) => Effect.Effect<void>;
}

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const cancelledCount = (json: unknown): number =>
  typeof json === "object" &&
  json !== null &&
  "cancelled" in json &&
  typeof (json as { cancelled: unknown }).cancelled === "number"
    ? (json as { cancelled: number }).cancelled
    : 0;

export const makeAwaySleep = (deps: AwaySleepDeps) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    let autoBringBack: Effect.Effect<void> | null = null;

    const sleep = (request: AwaySleepRequest) =>
      lock.withPermit(
        Effect.gen(function* () {
          const config = yield* deps.config;
          if (!sleepTriggerFires(config, deps.self, request.onBattery))
            return {
              answer: { outcome: "skipped" },
              send: Effect.void,
            } satisfies AwaySleepDecision;
          const target = config.target;
          const ids = yield* deps.ids({ ...config, target });
          const now = yield* Clock.currentTimeMillis;
          const session: AwaySleepSession = {
            state: "pending-intent",
            targetEnvironmentId: target,
            graceMinutes: config.graceMinutes,
            projectIds: ids.projectIds,
            threadIds: ids.threadIds,
            sentAt: isoAt(now),
            dueAt: isoAt(now + config.graceMinutes * MINUTE_MS),
          };
          yield* deps.store.write(session);
          const body: AwayIntentRequest = {
            sourceEnvironmentId: deps.self,
            graceMinutes: config.graceMinutes,
            ...ids,
          };
          const send = deps.post(target, AWAY_INTENT_PATH, body, AWAY_SLEEP_SEND_TIMEOUT_MS).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              lock.withPermit(
                Effect.gen(function* () {
                  const current = yield* deps.store.read;
                  // A wake that already settled the session wins.
                  if (current?.sentAt !== session.sentAt || current.state !== "pending-intent")
                    return;
                  yield* deps.store.write({
                    ...current,
                    state: "send-failed",
                    detail: `Work stayed here: ${error.message}`.slice(0, 500),
                  });
                }),
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Away: could not record the sleep intent", { cause }),
            ),
          );
          return { answer: { outcome: "left" }, send } satisfies AwaySleepDecision;
        }),
      );

    const wake = (request: AwayWakeRequest) =>
      lock.withPermit(
        Effect.gen(function* () {
          const session = yield* deps.store.read;
          if (session === null) return { outcome: "none" } satisfies AwayWakeAnswer;
          if (session.state === "send-failed") {
            yield* deps.store.write(null);
            return { outcome: "none" } satisfies AwayWakeAnswer;
          }
          // Already prompted on an earlier wake or unlock; the card reads the session.
          if (session.state === "wake-prompt") return { outcome: "none" } satisfies AwayWakeAnswer;
          const cancelled = yield* deps
            .post(
              session.targetEnvironmentId,
              AWAY_INTENT_CANCEL_PATH,
              { sourceEnvironmentId: deps.self },
              AWAY_SLEEP_SEND_TIMEOUT_MS,
            )
            .pipe(
              Effect.map((answer) => cancelledCount(answer.json)),
              Effect.orElseSucceed(() => 0),
            );
          const now = yield* Clock.currentTimeMillis;
          // Back before the grace ran out, or the target still held the intent:
          // nothing moved. A target that missed the cancel finds this machine
          // answering when the grace ends, and cancels on its own.
          if (cancelled > 0 || now < Date.parse(session.dueAt)) {
            yield* deps.store.write(null);
            return { outcome: "none" } satisfies AwayWakeAnswer;
          }
          yield* deps.store.write({ ...session, state: "wake-prompt", wokeAt: isoAt(now) });
          const config = yield* deps.config;
          if (config.bringBack === "manual") return { outcome: "none" } satisfies AwayWakeAnswer;
          if (
            config.bringBack === "auto-on-power" &&
            !request.onBattery &&
            autoBringBack !== null
          ) {
            yield* Effect.forkDetach(
              autoBringBack.pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Away: automatic bring back failed", { cause }),
                ),
              ),
            );
            return { outcome: "auto" } satisfies AwayWakeAnswer;
          }
          return { outcome: "prompt" } satisfies AwayWakeAnswer;
        }),
      );

    return {
      sleep,
      wake,
      session: deps.store.read,
      clear: lock.withPermit(deps.store.write(null)),
      onAutoBringBack: (handler) => Effect.sync(() => void (autoBringBack = handler)),
    } satisfies AwaySleepShape;
  });

export class AwaySleep extends Context.Service<AwaySleep, AwaySleepShape>()(
  "specweave-studio/away/awaySleepRoute/AwaySleep",
) {}

const decodeSession = Schema.decodeUnknownOption(AwaySleepSession);

function parseOrNull(text: string): unknown {
  try {
    return parseJson(text);
  } catch {
    return null;
  }
}
const encodeSession = Schema.encodeSync(AwaySleepSession);

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const handoff = yield* HandoffMode;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scheduled = yield* ScheduledTaskService;
  const post = yield* makeAwayPeerPost;
  const file = path.join(serverConfig.stateDir, FILE_NAME);

  const store: AwaySleepStore = {
    read: Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return null;
      return Option.getOrNull(decodeSession(parseOrNull(yield* fs.readFileString(file))));
    }).pipe(Effect.orElseSucceed(() => null)),
    write: (next) =>
      Effect.gen(function* () {
        if (next === null) {
          if (yield* fs.exists(file)) yield* fs.remove(file);
          return;
        }
        yield* fs.makeDirectory(serverConfig.stateDir, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${yield* crypto.randomUUIDv4}.tmp`;
        yield* fs.writeFileString(temporary, stringifyJson(encodeSession(next)), { mode: 0o600 });
        yield* fs.rename(temporary, file);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Away: could not save the sleep session", { cause }),
        ),
      ),
  };

  const core = yield* makeAwaySleep({
    self: handoff.environmentId,
    store,
    config: handoff.snapshot.pipe(
      Effect.map((snapshot) => awayConfigOf(snapshot.config)),
      // Without a readable config the trigger stays off.
      Effect.orElseSucceed(() => ({
        target: null,
        sleepTrigger: "off" as const,
        graceMinutes: 2,
        bringBack: "prompt" as const,
        coordinatorScope: "live" as const,
      })),
    ),
    ids: (config) =>
      Effect.gen(function* () {
        const projectList = yield* projects.snapshot.pipe(
          Effect.map((snapshot) => snapshot.projects),
          Effect.orElseSucceed(() => []),
        );
        const shells = yield* projections.getShellSnapshot({ unsettledOnly: false }).pipe(
          Effect.map((snapshot) => snapshot.threads),
          Effect.orElseSucceed(() => []),
        );
        const tasks = yield* scheduled.list().pipe(
          Effect.map((listed) => listed.tasks),
          Effect.orElseSucceed(() => []),
        );
        return sleepIntentIds({
          self: handoff.environmentId,
          target: config.target,
          coordinatorScope: config.coordinatorScope,
          projects: projectList,
          shells,
          tasks,
        });
      }),
    post,
  });
  return AwaySleep.of(core);
});

/** Needs HandoffMode, ProjectService, the projection store, routines and the fleet. */
export const layer = Layer.effect(AwaySleep, make);

// --- routes ----------------------------------------------------------------------

const decodeSleep = Schema.decodeUnknownOption(AwaySleepRequest);
const decodeWake = Schema.decodeUnknownOption(AwayWakeRequest);

const json = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

/** The caller is this machine's desktop main process; then the decoded body. */
const localCall = <A>(decode: (raw: unknown) => Option.Option<A>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (Option.isNone(session)) return { refused: json(401, { error: "unauthorized" }) } as const;
    if (!maySuspend(session.value)) return { refused: json(403, { error: "forbidden" }) } as const;
    const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const body = decode(text.length > 4096 ? null : parseOrNull(text));
    if (Option.isNone(body))
      return { refused: json(400, { error: "The request does not match this version." }) } as const;
    return { body: body.value } as const;
  });

const sleepRoute = HttpRouter.add(
  "POST",
  AWAY_SLEEP_PATH,
  Effect.gen(function* () {
    const call = yield* localCall(decodeSleep);
    if ("refused" in call) return call.refused;
    const decision = yield* (yield* AwaySleep).sleep(call.body);
    // Answer now so the main process can decide within its five seconds; the
    // send carries on while the Mac is still awake.
    yield* Effect.forkDetach(decision.send);
    return json(200, decision.answer);
  }),
);

const wakeRoute = HttpRouter.add(
  "POST",
  AWAY_WAKE_PATH,
  Effect.gen(function* () {
    const call = yield* localCall(decodeWake);
    if ("refused" in call) return call.refused;
    return json(200, yield* (yield* AwaySleep).wake(call.body));
  }),
);

export const routesLayer = Layer.mergeAll(sleepRoute, wakeRoute);
