/**
 * Several machines that share one project, each with its own database, its
 * own scheduler and its own coordinator role, joined by a network the test
 * can cut (1390 AC-45). A machine built with `release: "1.0.377"` answers the
 * routines route as that release did and never settles a runner.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  type Project,
  ProjectId,
  type ScheduledTask,
  ScheduledTaskId,
  ThreadId,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { decodeRoutinesRequest } from "../away/awayRoutinesRoute.ts";
import { AwayPeerError, type AwayPeerPost } from "../away/awayPeerCall.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { HandoffTurnGate } from "../handoff/HandoffTurnGate.ts";
import { parseJson, stringifyJson } from "../json.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import { CoordinatorRole } from "../project/CoordinatorRole.ts";
import { CoordinatorWakeGate } from "../project/CoordinatorWakeGate.ts";
import * as ProjectCoordinator from "../project/ProjectCoordinatorService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { DEFAULT_PROJECT_WORKSPACE_SETTINGS } from "../../../../packages/contracts/src/projectWorkspace.ts";
import { type RoutineRunner, RoutineRunnerPace } from "./ScheduledTaskRunner.ts";
import { type RoutineTransferRefusal } from "./ScheduledTaskRunnerWire.ts";
import {
  type Role,
  roleService,
  taskInput,
} from "./ScheduledTaskService.coordinatorGate.testkit.ts";
import * as Service from "./ScheduledTaskService.ts";
import { routineProject } from "./ScheduledTaskService.test-fixtures.ts";
import { receive377 } from "./ScheduledTaskTransfer.release377.testkit.ts";
import { taskError } from "./ScheduledTaskStorage.ts";
import { makeTransfer, type ScheduledTaskTransfer } from "./ScheduledTaskTransfer.ts";

/** A body as the other machine reads it: JSON, so nothing JSON cannot carry arrives. */
export const overTheWire = (value: unknown): unknown => parseJson(stringifyJson(value));

export const ROUTINE = ScheduledTaskId.make("routine");
export const STANDBY: Role = { active: false, epoch: 1, state: "transferred" };
export const COORDINATES: Role = { active: true, epoch: 1, state: "active" };

type Route = (
  caller: ReceiverCaller,
  body: unknown,
) => Effect.Effect<
  unknown,
  RoutineTransferRefusal | { readonly status: number; readonly message: string }
>;

export interface Machine {
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly state: {
    role: Role;
    fence: string | null;
    launches: number;
    sends: number;
    /** Threads handed off from this machine, and where to. */
    movedThreads: Map<string, string>;
    /** Its coordinator was started beside the project's own: active, and no predecessor. */
    beside: boolean;
    /** The move's reads of this machine's routines fail, as a database that cannot be read. */
    listFails: boolean;
    /** Machines this one's project is no longer linked with. */
    unlinked: Set<string>;
    /**
     * Runs once, just before this machine's scheduler next reads every
     * routine's revision count: where a change saved by another request lands
     * between two reads of one pass.
     */
    beforeRevisionsRead: Effect.Effect<void> | null;
  };
  readonly sql: SqlClient.SqlClient;
  readonly service: Service.ScheduledTaskService["Service"];
  readonly runner: RoutineRunner;
  /** Absent on a 1.0.377 machine. */
  readonly transfer: ScheduledTaskTransfer["Service"] | null;
  /** This machine's requests to the others' routines routes, as its own move sends them. */
  readonly post: AwayPeerPost;
  /** One pass of this machine's scheduler over what is due. */
  readonly due: Effect.Effect<void>;
  /**
   * The server again over the same database: a new scheduler, runner and
   * move, with nothing kept in memory. Not a process restart.
   */
  readonly reopen: Effect.Effect<void>;
  /** Makes every `verb` on `table` fail in this machine's database until the returned effect runs. */
  readonly breakTable: (
    table: string,
    verb: "INSERT" | "UPDATE" | "DELETE",
  ) => Effect.Effect<Effect.Effect<void>>;
  /** How many times this machine started a routine's run. */
  readonly fires: () => number;
  readonly row: Effect.Effect<
    | {
        readonly enabled: number;
        readonly next_run_at: string | null;
        readonly last_run_error: string | null;
        readonly run_count: number;
        readonly title: string;
      }
    | undefined
  >;
  readonly record: Effect.Effect<Effect.Success<ReturnType<RoutineRunner["records"]["read"]>>>;
  /** Saves this machine's copy of the routine as a release before runners left it. */
  readonly seed: (overrides?: Record<string, unknown>) => Effect.Effect<ScheduledTask>;
  readonly makeDue: (at: string) => Effect.Effect<void>;
}

export interface Network {
  /** Machines that neither send nor receive. */
  readonly offline: Set<string>;
  /** The request arrives and is acted on; its answer is lost. Called once per request. */
  dropAnswer: (from: string, to: string, op: string) => boolean;
  /** Runs as a request leaves, before the other machine sees it. */
  before?: ((from: string, to: string, op: string) => Effect.Effect<void>) | undefined;
  /** Runs once the other machine acted on a request, before its answer is back. */
  during?: ((from: string, to: string, op: string) => Effect.Effect<void>) | undefined;
  /** What `from`'s routines may do on `to`; absent, anything. */
  ceiling?: ((from: string, to: string) => RuntimeMode) | undefined;
  /** Every request sent, as `from>to:op`. */
  readonly log: Array<string>;
}

const grantFor = (source: EnvironmentId): EffectiveWorkGrant => ({
  coordinatorEnvironmentId: source,
  projects: { kind: "all" },
  accounts: { kind: "all" },
  owner: "self",
  hopLimit: 2,
  revoked: false,
  routines: true,
  kind: "own",
});

/**
 * `names` are the machines, in member order; each one's project is
 * `project-<name>` and its environment id `env-<name>`.
 */
export const fleet = (
  names: ReadonlyArray<string>,
  options: {
    readonly release?: Record<string, "1.0.377">;
    /** How often a due pass looks for routines to settle; absent, the test settles by hand. */
    readonly pace?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const network: Network = { offline: new Set(), dropAnswer: () => false, log: [] };
    const routes = new Map<string, Route>();
    const members = names.map((name) => ({
      environmentId: EnvironmentId.make(`env-${name}`),
      projectId: ProjectId.make(`project-${name}`),
      coordinatorThreadId: ThreadId.make(`project-coordinator:project-${name}`),
    }));
    const nameOf = (environmentId: string) => environmentId.replace(/^env-/, "");

    const postFrom =
      (self: EnvironmentId): AwayPeerPost =>
      (target, _path, body) =>
        Effect.gen(function* () {
          const wire = overTheWire(body) as { readonly op?: string };
          const from = nameOf(self);
          const to = nameOf(target);
          network.log.push(`${from}>${to}:${wire.op ?? "?"}`);
          if (network.before !== undefined) yield* network.before(from, to, wire.op ?? "?");
          const route = routes.get(target);
          if (route === undefined || network.offline.has(from) || network.offline.has(to))
            return yield* new AwayPeerError({
              message: `${to} did not answer.`,
              refused: false,
              uncertain: false,
            });
          const answered = yield* route(
            {
              sourceEnvironmentId: self,
              grant: grantFor(self),
              runtimeCeiling: network.ceiling?.(from, to) ?? "full-access",
            },
            wire,
          ).pipe(Effect.result);
          if (network.during !== undefined) yield* network.during(from, to, wire.op ?? "?");
          if (network.dropAnswer(from, to, wire.op ?? "?"))
            return yield* new AwayPeerError({
              message: `${to} did not answer.`,
              refused: false,
              uncertain: true,
            });
          if (answered._tag === "Failure")
            return yield* new AwayPeerError({
              message: `${to}: ${answered.failure.message}`,
              refused: true,
              uncertain: false,
              status: answered.failure.status,
            });
          return { status: 200, json: overTheWire(answered.success) };
        });

    const machine = (name: string, index: number) =>
      Effect.gen(function* () {
        const { environmentId, projectId } = members[index]!;
        const state: Machine["state"] = {
          role: index === 0 ? COORDINATES : STANDBY,
          fence: null,
          launches: 0,
          sends: 0,
          movedThreads: new Map(),
          beside: false,
          listFails: false,
          unlinked: new Set(),
          beforeRevisionsRead: null,
        };
        // The binding this copy's project row carries, as the release before wrote it.
        const binding = () =>
          state.role.state !== "active"
            ? { epoch: state.role.epoch, state: state.role.state }
            : state.role.epoch === 0
              ? undefined
              : {
                  epoch: state.role.epoch,
                  state: "active" as const,
                  ...(state.beside ? {} : { predecessor: members[(index + 1) % members.length]! }),
                };
        const work = { due: Effect.void as Effect.Effect<void> };
        const projectRow = (): ProjectStore.ProjectRow => ({
          ...routineProject(projectId),
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            ...(binding() === undefined ? {} : { coordinatorBinding: binding() }),
            logicalProject: {
              id: "logical-a",
              title: "Synthetic shared project",
              coordinatorId: "coordinator",
              members: members.filter((member) => !state.unlinked.has(member.environmentId)),
            },
          },
        });
        const dependencies = Layer.mergeAll(
          NodeCrypto.layer,
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id: ProjectId) =>
              Effect.succeed(id === projectId ? Option.some(projectRow()) : Option.none()),
            list: () => Effect.succeed([projectRow()]),
          }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            launch: () =>
              Effect.sync(() => {
                state.launches++;
                return { threadId: "synthetic", resumed: false } as never;
              }),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(null),
            sendToThread: () =>
              Effect.sync(() => {
                state.sends++;
                return {} as never;
              }),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ProcessRunner.ProcessRunner)({}),
          Layer.mock(ProjectCoordinator.ProjectCoordinatorService)({
            start: (input) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                state.launches++;
                yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: `project-coordinator:${input.projectId}`, project_id: input.projectId, title: "Coordinator", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`.pipe(
                  Effect.orDie,
                );
                return {
                  threadId: ThreadId.make(`project-coordinator:${input.projectId}`),
                  created: false,
                };
              }).pipe(Effect.provideService(SqlClient.SqlClient, sqlRef.current!)),
            nextTurnModel: () => Effect.succeed(undefined as never),
          }),
          Layer.mock(Scheduler.Scheduler)({
            register: <E, R>(_name: string, effect: Effect.Effect<void, E, R>) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<R>();
                work.due = effect.pipe(Effect.provideContext(context), Effect.orDie);
              }),
            heldMsBetween: () => Effect.succeed(0),
          }),
          // The tests settle by hand, through `runner.reconcile`.
          Layer.succeed(RoutineRunnerPace, { everyMs: options.pace ?? null }),
          Layer.succeed(CoordinatorRole, CoordinatorRole.of(roleService(state, Stream.empty))),
          Layer.succeed(CoordinatorWakeGate, { check: () => Effect.sync(() => state.fence) }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
          // Each machine lets the others run work, and manage routines, here.
          Layer.succeed(WorkGrants.WorkGrants, {
            ...WorkGrants.WorkGrants.defaultValue(),
            enabled: true,
            policies: Effect.succeed(
              members
                .filter((member) => member.environmentId !== environmentId)
                .map((member) => ({
                  coordinatorEnvironmentId: member.environmentId,
                  projects: { kind: "all" as const },
                  accounts: { kind: "all" as const },
                  owner: "self" as const,
                  legacy: false,
                  routines: true,
                  runtimeCap: null,
                  createdAt: "2026-10-09T00:00:00.000Z",
                  updatedAt: "2026-10-09T00:00:00.000Z",
                  revokedAt: null,
                  interruptAt: null,
                  interruptedAt: null,
                })),
            ),
          }),
          Layer.succeed(HandoffTurnGate, {
            ...HandoffTurnGate.defaultValue(),
            continuedOn: (threadId) => Effect.sync(() => state.movedThreads.get(threadId) ?? null),
          }),
        );
        const sqlRef: { current: SqlClient.SqlClient | null } = { current: null };
        const database = yield* Layer.build(Layer.fresh(Sqlite.layerMemory));
        const sql = Context.get(database, SqlClient.SqlClient);
        sqlRef.current = sql;
        // The scheduler's own client: the same database, with the one seam above.
        const watched = new Proxy(sql, {
          apply: (target, self, args: Array<unknown>) => {
            const statement = Reflect.apply(target as never, self, args) as Effect.Effect<unknown>;
            const text = Array.isArray(args[0]) ? args[0].join("?") : "";
            if (!/SELECT task_id, revision FROM scheduled_task_revisions\s*$/.test(text))
              return statement;
            return Effect.suspend(() => {
              const hook = state.beforeRevisionsRead ?? Effect.void;
              state.beforeRevisionsRead = null;
              return hook;
            }).pipe(Effect.andThen(statement));
          },
        });
        const context = yield* Layer.build(
          Layer.fresh(
            Service.layer.pipe(
              Layer.provide(dependencies),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, watched)),
            ),
          ),
        );
        const old = options.release?.[name] === "1.0.377";
        const projects = Effect.sync(() => {
          const row = projectRow();
          return [
            { id: row.projectId, deletedAt: null, workspaceSettings: row.workspaceSettings },
          ] as unknown as ReadonlyArray<Project>;
        });
        /** The scheduler, its runner and its move over `service`, as a server start builds them. */
        const serverOver = (service: Service.ScheduledTaskService["Service"]) =>
          Effect.gen(function* () {
            const runner = yield* service.runner!();
            const transfer = old
              ? null
              : yield* makeTransfer({
                  sql,
                  scheduled: {
                    ...service,
                    list: () =>
                      state.listFails
                        ? Effect.fail(taskError("Could not list schedule tasks."))
                        : service.list(),
                  },
                  post: postFrom(environmentId),
                  projects,
                  label: (id) => Effect.succeed(nameOf(id)),
                });
            return { service, runner, transfer };
          });
        const live = {
          current: yield* serverOver(Context.get(context, Service.ScheduledTaskService)),
        };
        const service = new Proxy({} as Service.ScheduledTaskService["Service"], {
          get: (_target, key) => live.current.service[key as keyof typeof live.current.service],
        });
        const scope = yield* Effect.scope;
        const reopen = Effect.gen(function* () {
          const again = yield* Layer.buildWithScope(
            Layer.fresh(
              Service.layer.pipe(
                Layer.provide(dependencies),
                Layer.provide(Layer.succeed(SqlClient.SqlClient, watched)),
              ),
            ),
            scope,
          );
          live.current = yield* serverOver(Context.get(again, Service.ScheduledTaskService));
        }).pipe(Effect.orDie);
        const readState = (id: string) =>
          sql<{
            next_run_at: string | null;
            last_run_at: string | null;
            run_count: number;
          }>`SELECT next_run_at, last_run_at, run_count FROM scheduled_tasks WHERE task_id = ${id}`.pipe(
            Effect.map((rows) =>
              rows[0] === undefined
                ? null
                : {
                    nextRunAt: rows[0].next_run_at,
                    lastRunAt: rows[0].last_run_at,
                    runCount: rows[0].run_count,
                    onceGeneration: 0,
                  },
            ),
            Effect.orDie,
          );
        routes.set(
          environmentId,
          old
            ? // The release before: its own schema, its own steps, on this machine's scheduler.
              (caller, body) =>
                receive377({
                  projects,
                  findTask: (id) =>
                    Effect.gen(function* () {
                      const listed = yield* service.list().pipe(Effect.orDie);
                      const task = listed.tasks.find((entry) => entry.id === id);
                      if (task === undefined) return null;
                      return {
                        projectId: task.projectId,
                        grantedBy: yield* service.readGrant!(task.id).pipe(Effect.orDie),
                      };
                    }),
                  upsert: (input, grantedBy) =>
                    service.upsert(input, { grantedBy }).pipe(
                      Effect.asVoid,
                      Effect.mapError((error) => error.message),
                    ),
                  setEnabled: (id, enabled) =>
                    service.setEnabled({ id, enabled }).pipe(
                      Effect.as(true),
                      Effect.mapError((error) => error.message),
                    ),
                  remove: (id) =>
                    service.delete({ id }).pipe(
                      Effect.asVoid,
                      Effect.mapError((error) => error.message),
                    ),
                  readState,
                  writeState: (project, id, runState) =>
                    sql`
                      UPDATE scheduled_tasks
                      SET next_run_at = ${runState.nextRunAt}, last_run_at = ${runState.lastRunAt},
                        run_count = ${runState.runCount}
                      WHERE task_id = ${id} AND project_id = ${project}
                    `.pipe(Effect.asVoid, Effect.orDie),
                })(caller, body).pipe(Effect.map((answer) => answer.json))
            : (caller, body) => {
                const request = decodeRoutinesRequest(body);
                return Option.isNone(request)
                  ? Effect.fail({
                      status: 400,
                      message: "The request does not match this version.",
                    })
                  : live.current.transfer!.receive(caller, request.value);
              },
        );
        const row = sql<{
          enabled: number;
          next_run_at: string | null;
          last_run_error: string | null;
          run_count: number;
          title: string;
        }>`SELECT enabled, next_run_at, last_run_error, run_count, title FROM scheduled_tasks WHERE task_id = ${ROUTINE}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie,
        );
        return {
          name,
          environmentId,
          projectId,
          state,
          sql,
          service,
          get runner() {
            return live.current.runner;
          },
          get transfer() {
            return live.current.transfer;
          },
          due: Effect.suspend(() => work.due),
          reopen,
          breakTable: (table, verb) =>
            Effect.gen(function* () {
              const trigger = `synthetic_failure_${table}_${verb.toLowerCase()}`;
              yield* sql.unsafe(
                `CREATE TRIGGER IF NOT EXISTS ${trigger} BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
              );
              return sql
                .unsafe(`DROP TRIGGER IF EXISTS ${trigger}`)
                .pipe(Effect.asVoid, Effect.orDie);
            }).pipe(Effect.orDie),
          fires: () => state.launches + state.sends,
          post: postFrom(environmentId),
          row,
          record: Effect.suspend(() => live.current.runner.records.read(ROUTINE)),
          seed: (overrides = {}) =>
            live.current.runner.internal.upsert(taskInput({ projectId, ...overrides })).pipe(
              Effect.map((result) => result.task),
              Effect.orDie,
            ),
          makeDue: (at) =>
            sql`UPDATE scheduled_tasks SET next_run_at = ${at} WHERE task_id = ${ROUTINE}`.pipe(
              Effect.asVoid,
              Effect.orDie,
            ),
        } satisfies Machine;
      }).pipe(Effect.orDie);

    const machines: Array<Machine> = [];
    for (const [index, name] of names.entries()) machines.push(yield* machine(name, index));
    return {
      network,
      machines,
      /** Every machine's scheduler looks at what is due, in order. */
      everyoneLooks: Effect.forEach(machines, (entry) => entry.due, { discard: true }),
      /** How many times the routine was started, on all machines together. */
      fires: () => machines.reduce((sum, entry) => sum + entry.fires(), 0),
    };
  });

/**
 * What a row on `machine` sends with a toggle or a delete: the definition its
 * list shows for the routine, where it shows one (a copy another machine runs).
 */
export const shownOn = (machine: Machine) =>
  machine.service.list().pipe(
    Effect.map((list) => {
      const hash = list.tasks.find((task) => task.id === ROUTINE)?.definitionHash;
      return hash === undefined ? {} : { expectedDefinition: hash };
    }),
  );
