// @effect-diagnostics anyUnknownInErrorContext:off -- the seat kit stubs services with loosely typed fakes.
/**
 * Machines that share one Percy, in process, for the `personal-share` tests
 * (1448 T-14). Each seat has its own memory store, `LinkedMemorySync`,
 * `PersonalShareEngine` and state; seats reach each other through an
 * in-process network that authenticates the caller the way the peer route
 * does (the grant the callee issued to it, and the Connect user id header the
 * caller sends) and that round-trips every request and response through the
 * wire schemas. Only the project row store, the restore points and the
 * database copy are stand-ins.
 */
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  EventId,
  type LogicalProjectMember,
  ProjectPlanError,
  type PersonalAssistantShared,
  type Project,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { ConnectAccount } from "../cloud/connectAccount.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import { HandoffRefusal } from "../handoff/HandoffReceiver.ts";
import { HandoffPeerError } from "../handoff/handoffPeers.ts";
import type { LinkedDigestRequest } from "../handoff/linkedSyncWire.ts";
import { PersonalShareRequest, PersonalShareResponse } from "../handoff/personalShareWire.ts";
import {
  ownershipRejection,
  resolveSharedSettingsStamp,
} from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import * as LinkedMemorySync from "./LinkedMemorySync.ts";
import { describeCopy, linkedCopyFor } from "./LinkedPeerRoute.ts";
import { type LinkedPeerSyncDeps, makeLinkedPeerSync } from "./LinkedPeerSync.ts";
import * as LinkedPeerSyncState from "./LinkedPeerSyncState.ts";
import { personalPeerSyncDeps, unlinkedPersonalIdentity } from "./PersonalPeerSync.ts";
import { makePersonalShareEngine, type PersonalShareEngine } from "./PersonalShareEngine.ts";
import { makePersonalShareReconciler } from "./PersonalShareReconciler.ts";
import type { PersonalRestorePointSummary } from "./personalRestorePoint.ts";
import * as PersonalShareState from "./PersonalShareState.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";

export const USER = "user_owner_1";
export const OTHER_USER = "user_someone_else";

type Patch = Record<string, any>;

export type GrantKind = "own" | "team" | "legacy" | "revoked";

/** A work grant one machine issued to another, as the route hands it to the callee. */
export const grantOf = (coordinator: EnvironmentId, kind: GrantKind): EffectiveWorkGrant =>
  ({
    coordinatorEnvironmentId: coordinator,
    kind: kind === "team" ? "team" : "own",
    owner: kind === "team" ? "team" : "self",
    legacy: kind === "legacy",
    revoked: kind === "revoked",
    maxRuntimeMode: "full-access",
    projects: { kind: "none" },
    accounts: { kind: "all" },
  }) as unknown as EffectiveWorkGrant;

const shareGrantKindOf = (kind: GrantKind | undefined) =>
  kind === undefined || kind === "revoked" ? ("none" as const) : kind;

const encodeRequest = Schema.encodeSync(PersonalShareRequest);
const decodeRequest = Schema.decodeUnknownSync(PersonalShareRequest);
const encodeResponse = Schema.encodeSync(PersonalShareResponse);
const decodeResponse = Schema.decodeUnknownSync(PersonalShareResponse);

/** One call one seat received on `personal-share`, as it arrived. */
export interface ReceivedCall {
  readonly from: EnvironmentId;
  readonly request: PersonalShareRequest;
  readonly response: PersonalShareResponse | null;
}

export interface SeatOptions {
  /** The assistant's creation time; the older one is the machine's assistant. */
  readonly createdAt?: string;
  readonly account?: ConnectAccount;
}

/** What the in-process network needs of a machine to call it. */
export interface NetworkPeer {
  readonly isOnline: () => boolean;
  readonly isOldVersion: () => boolean;
  readonly issuedTo: (peer: EnvironmentId) => GrantKind | undefined;
  readonly answerFrom: (
    from: EnvironmentId,
    grant: EffectiveWorkGrant | null,
    cloudUserId: string | null,
    request: PersonalShareRequest,
  ) => Effect.Effect<PersonalShareResponse, HandoffRefusal>;
}

/** The machines that can reach each other, by environment id. */
export type Network = Map<EnvironmentId, NetworkPeer>;

/** One machine with its Percy, its settings, its grants and its share engine. */
export const makeShareSeat = (
  network: Network,
  name: string,
  label: string,
  options: SeatOptions = {},
) =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make(`env-${name}`);
    const projectId = ProjectId.make(`percy-${name}`);
    const createdAt = options.createdAt ?? "2026-11-01T00:00:00.000Z";
    let project: Project = {
      id: projectId,
      title: "Percy",
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      faviconPath: null,
      projectIcon: { kind: "lucide", name: "sparkles", color: "violet" },
      workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, kind: "personal", revision: 1 },
    };
    const refusals: string[] = [];
    const updates: Patch[] = [];
    /** Fails the next N writes of a link (join-as-member), as a full disk would. */
    let failLinkWrites = 0;

    const update = (input: Patch) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) => {
          const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
          const expected =
            input.ownership?.expectedRevision ?? input.workspaceSettings?.expectedRevision;
          const reject = (message: string) => {
            refusals.push(message);
            return Effect.fail({ _tag: "ProjectSettingsRevisionConflictError", message } as any);
          };
          if (input.ownership?.mode === "join-as-member" && failLinkWrites > 0) {
            failLinkWrites -= 1;
            return reject("link write failed");
          }
          if (expected !== undefined && expected !== settings.revision) return reject("revision");
          if (input.ownership) {
            const rejection = ownershipRejection(project.id, settings, input.ownership);
            if (rejection !== undefined) return reject(rejection);
          }
          const shared = resolveSharedSettingsStamp(
            project,
            settings,
            input as any,
            DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          );
          if (shared.refused) return reject("stamp not newer");
          updates.push(input);
          const { expectedRevision: _ignored, ...patch } = input.workspaceSettings ?? {};
          project = {
            ...project,
            title: input.title ?? project.title,
            projectIcon: input.projectIcon !== undefined ? input.projectIcon : project.projectIcon,
            workspaceSettings: {
              ...settings,
              ...patch,
              ...(shared.stamp !== undefined ? { sharedSettingsUpdatedAt: shared.stamp } : {}),
              ...(input.ownership
                ? {
                    logicalProject: input.ownership.logicalProject,
                    coordinatorBinding: input.ownership.coordinatorBinding,
                  }
                : {}),
              revision: settings.revision + 1,
            },
          };
          return Effect.succeed(project);
        }),
      );

    const projects = {
      getById: (id: ProjectId) =>
        Effect.sync(() => (id === project.id ? Option.some(project) : Option.none())),
      snapshot: Effect.sync(() => ({ projects: [project] })),
      update,
    } as unknown as ProjectService.ProjectService["Service"];

    const storage = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
    const workspaceLayer = Workspace.layer.pipe(
      Layer.provideMerge(Layer.merge(storage, LinkedMemoryHistory.layerMemory)),
    );
    const environment = {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.succeed({
        environmentId,
        label,
        platform: { os: "darwin", arch: "arm64" },
      }),
    } as unknown as ServerEnvironment.ServerEnvironment["Service"];
    const base = Layer.mergeAll(
      workspaceLayer,
      Layer.succeed(ServerEnvironment.ServerEnvironment, environment),
      Layer.succeed(ProjectService.ProjectService, projects),
    );
    const context = yield* Layer.buildWithMemoMap(
      LinkedMemorySync.layer.pipe(Layer.provideMerge(base)),
      yield* Layer.makeMemoMap,
      yield* Effect.scope,
    );
    const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.provide(effect, context) as Effect.Effect<A, E>;
    yield* run(
      Effect.gen(function* () {
        const store = yield* ProjectStore.ProjectStoreV2;
        yield* store.apply({
          sequence: 1,
          eventId: EventId.make(`event:${projectId}`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: createdAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Percy",
            workspaceRoot: `/tmp/${projectId}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          },
        } as any);
      }),
    );
    const workspace = yield* run(Workspace.ProjectWorkspaceService);
    const histories = yield* run(LinkedMemoryHistory.LinkedMemoryHistory);
    const memory = yield* run(LinkedMemorySync.LinkedMemorySync);

    // This machine's own settings and Connect sign-in.
    let shared: PersonalAssistantShared = { enabled: false, machines: [] };
    let aideEnabled = true;
    let settingsReadable = true;
    let account: ConnectAccount = options.account ?? { status: "linked", cloudUserId: USER };
    /** What the caller sends as its Connect user id header; defaults to its account. */
    let header: string | null | undefined;
    let online = true;
    /** Answers `personal-share` with 404, as a version from before the path. */
    let oldVersion = false;

    // Grants: the ones this machine issued (peers call it with them), and the ones it holds.
    const issued = new Map<EnvironmentId, GrantKind>();
    const held = new Map<EnvironmentId, boolean>();

    // The one-time copies, counted.
    const points: Array<PersonalRestorePointSummary & { readonly projectId: ProjectId }> = [];
    const snapshots: string[] = [];
    const restorePoints = {
      capture: (id: ProjectId, reason: "before-link" | "before-undo") =>
        Effect.gen(function* () {
          const files = yield* workspace.readMemoryFiles({ projectId: id }).pipe(Effect.orDie);
          const savedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
          const point = {
            projectId: id,
            id: `${savedAt}-${points.length}`,
            savedAt,
            reason,
            memoryFileCount: files.length,
            path: `/tmp/backups/personal-link/${points.length}.percy.json`,
          };
          points.push(point);
          return point;
        }),
      list: (id: ProjectId) =>
        Effect.sync(() => points.filter((point) => point.projectId === id).toReversed()),
    };
    const snapshot = {
      snapshot: (operationId: string) =>
        Effect.sync(() => {
          snapshots.push(operationId);
          return `/tmp/backups/personal-link/${operationId}.sqlite`;
        }),
    };

    const states = yield* PersonalShareState.make;
    const received: ReceivedCall[] = [];
    const sent: Array<{ readonly to: EnvironmentId; readonly request: PersonalShareRequest }> = [];

    const callerHeader = () =>
      header !== undefined ? header : account.status === "linked" ? account.cloudUserId : null;

    const asPeerError = (error: unknown) =>
      error instanceof HandoffRefusal
        ? new HandoffPeerError({
            code: error.code,
            message: error.message,
            check: error.check,
            uncertain: false,
          })
        : new HandoffPeerError({ code: "failed", message: String(error), uncertain: false });

    const peers = {
      personalShare: (target: EnvironmentId, request: PersonalShareRequest) =>
        Effect.gen(function* () {
          sent.push({ to: target, request });
          const callee = network.get(target);
          if (callee === undefined || !callee.isOnline())
            return yield* new HandoffPeerError({
              code: "unreachable",
              message: "offline",
              uncertain: true,
            });
          if (callee.isOldVersion())
            return yield* new HandoffPeerError({
              code: "invalid",
              message: "Needs update",
              check: "version",
              uncertain: false,
              needsUpdate: true,
            });
          // The route authenticates the caller by the grant the callee issued it.
          const grant = callee.issuedTo(environmentId);
          if (grant === undefined || grant === "revoked")
            return yield* new HandoffPeerError({
              code: "needs_grant",
              message: "No grant for this machine.",
              uncertain: false,
            });
          const wire = decodeRequest(encodeRequest(request));
          const answer = yield* callee
            .answerFrom(environmentId, grantOf(environmentId, grant), callerHeader(), wire)
            .pipe(Effect.mapError(asPeerError));
          return decodeResponse(encodeResponse(answer));
        }),
    };

    const engine: PersonalShareEngine["Service"] = yield* makePersonalShareEngine({
      selfEnvironmentId: environmentId,
      selfLabel: Effect.succeed(label),
      account: Effect.sync(() => account),
      settings: Effect.suspend(() =>
        settingsReadable
          ? Effect.succeed({ shared, aideEnabled })
          : Effect.fail("settings unreadable" as const),
      ),
      projects,
      workspace,
      histories,
      restorePoints: restorePoints as any,
      snapshot,
      grants: {
        issued: (peer) => Effect.sync(() => shareGrantKindOf(issued.get(peer))),
        held: (peer) => Effect.sync(() => held.get(peer) === true),
      },
      peers: peers as any,
      states,
    });

    const reconciler = yield* makePersonalShareReconciler({
      selfEnvironmentId: environmentId,
      engine,
      states,
    });

    /** Runs before this machine answers a call, as the owner acting while a call is in flight. */
    let onReceive: ((request: PersonalShareRequest) => void) | undefined;

    const answerFrom = (
      from: EnvironmentId,
      grant: EffectiveWorkGrant | null,
      cloudUserId: string | null,
      request: PersonalShareRequest,
    ) =>
      Effect.sync(() => onReceive?.(request)).pipe(
        Effect.andThen(
          engine.answer({ sourceEnvironmentId: from, grant, cloudUserId } as any, request),
        ),
        Effect.tap((response) => Effect.sync(() => received.push({ from, request, response }))),
        Effect.tapError(() => Effect.sync(() => received.push({ from, request, response: null }))),
      );

    const write = (file: string, content: string) =>
      Effect.gen(function* () {
        const current = yield* workspace.readMemory({ projectId, name: file }).pipe(Effect.option);
        return yield* workspace.writeMemory({
          projectId,
          name: file,
          content,
          expectedRevision: Option.isSome(current) ? current.value.revision : null,
        });
      });
    const contents = Effect.gen(function* () {
      const result: Record<string, string> = {};
      for (const file of yield* workspace.readMemoryFiles({ projectId }))
        result[file.name] = file.content;
      return result;
    });

    const seat = {
      environmentId,
      projectId,
      label,
      engine,
      reconciler,
      states,
      projects,
      environment,
      memory,
      workspace,
      histories,
      run,
      write,
      contents,
      refusals,
      updates,
      received,
      sent,
      points,
      snapshots,
      current: () => project,
      identity: () => project.workspaceSettings?.logicalProject,
      binding: () => project.workspaceSettings?.coordinatorBinding,
      members: () =>
        (project.workspaceSettings?.logicalProject?.members ?? [])
          .map((member) => member.environmentId as string)
          .toSorted(),
      /** The owner's switch: on with these machines confirmed, and the starter's choice. */
      switchOn: (
        machines: ReadonlyArray<EnvironmentId>,
        extras: {
          readonly start?: boolean;
          readonly name?: string;
          readonly enabledAt?: string;
        } = {},
      ) => {
        shared = { enabled: true, machines: [...machines], ...extras };
      },
      switchOff: () => {
        shared = { ...shared, enabled: false };
      },
      setShared: (next: PersonalAssistantShared) => {
        shared = next;
      },
      setAideEnabled: (value: boolean) => {
        aideEnabled = value;
      },
      setSettingsReadable: (value: boolean) => {
        settingsReadable = value;
      },
      setAccount: (next: ConnectAccount) => {
        account = next;
      },
      setHeader: (value: string | null | undefined) => {
        header = value;
      },
      setOnline: (value: boolean) => {
        online = value;
      },
      setOldVersion: (value: boolean) => {
        oldVersion = value;
      },
      setOnReceive: (hook: ((request: PersonalShareRequest) => void) | undefined) => {
        onReceive = hook;
      },
      failNextLinkWrites: (count: number) => {
        failLinkWrites = count;
      },
      isOnline: () => online,
      isOldVersion: () => oldVersion,
      /** This machine issues `peer` a grant of `kind` (the peer calls with it) or none. */
      issue: (peer: EnvironmentId, kind: GrantKind | undefined) => {
        if (kind === undefined) issued.delete(peer);
        else issued.set(peer, kind);
      },
      issuedTo: (peer: EnvironmentId) => issued.get(peer),
      /** This machine holds a usable grant on `peer`. */
      hold: (peer: EnvironmentId, value: boolean) => {
        held.set(peer, value);
      },
      answerFrom,
      /** Leaves the link on this machine as `PersonalLinkService.leave` does, at the clock's time. */
      unlink: Effect.gen(function* () {
        const nowIso = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const left = yield* unlinkedPersonalIdentity(project, environmentId, nowIso);
        if (left === null) return;
        const settings = project.workspaceSettings!;
        project = {
          ...project,
          workspaceSettings: {
            ...settings,
            logicalProject: left.logicalProject,
            coordinatorBinding: left.coordinatorBinding,
            revision: settings.revision + 1,
          },
        };
      }),
    };
    network.set(environmentId, seat);
    return seat;
  });

export type ShareSeat = Effect.Success<ReturnType<typeof makeShareSeat>>;

/**
 * Two machines of one account that confirmed each other, with own grants
 * both ways unless `grants` says otherwise.
 */
export const pairUp = (
  a: ShareSeat,
  b: ShareSeat,
  grants: {
    readonly aIssuesB?: GrantKind | undefined;
    readonly bIssuesA?: GrantKind | undefined;
  } = {
    aIssuesB: "own",
    bIssuesA: "own",
  },
) => {
  a.issue(b.environmentId, grants.aIssuesB);
  b.issue(a.environmentId, grants.bIssuesA);
  // A machine holds what the other issued it, whatever kind that is.
  a.hold(b.environmentId, grants.bIssuesA !== undefined && grants.bIssuesA !== "revoked");
  b.hold(a.environmentId, grants.aIssuesB !== undefined && grants.aIssuesB !== "revoked");
};

/** Requests that carried content, by sender. */
export const contentSent = (seat: ShareSeat) =>
  seat.sent.filter((entry) => entry.request.content !== undefined);

/** Responses that carried content, by callee. */
export const contentAnswered = (seat: ShareSeat) =>
  seat.received.filter((entry) => entry.response?.content !== undefined);

export const sharedMemoryNames = (seat: ShareSeat) =>
  seat.contents.pipe(Effect.map((files) => Object.keys(files).toSorted()));

/** Every seat runs one reconcile tick, in turn, `rounds` times, a minute apart. */
export const reconcileRounds = (seats: ReadonlyArray<ShareSeat>, rounds: number) =>
  Effect.gen(function* () {
    for (let round = 0; round < rounds; round += 1) {
      for (const seat of seats) yield* seat.reconciler.tick;
      yield* TestClock.adjust("1 minute");
    }
  });

/**
 * One `LinkedPeerSync` pass for `seat` toward the others, as the server runs
 * it after the reconciler: the real route gate (`linkedCopyFor`) and digest
 * (`describeCopy`), the personal pair roles from the share engine's reach, and
 * memory moved by each seat's `LinkedMemorySync`.
 */
export const linkedTick = (seat: ShareSeat, all: ReadonlyArray<ShareSeat>) =>
  Effect.gen(function* () {
    const others = all.filter((other) => other !== seat);
    const byEnv = (environmentId: EnvironmentId) =>
      others.find((other) => other.environmentId === environmentId)!;
    const describeOn = (target: ShareSeat, project: Project, member: LogicalProjectMember) =>
      describeCopy(
        {
          link: { digest: () => Effect.die("no coordinator digest for a personal seat") },
          memory: target.memory,
          plans: {
            exportLinked: ({ projectId }) =>
              Effect.fail(new ProjectPlanError({ projectId, code: "read_only" })),
          },
        },
        project,
        member,
      );
    const asPeerError = (error: unknown) =>
      error instanceof HandoffRefusal
        ? new HandoffPeerError({
            code: error.code,
            message: error.message,
            check: error.check,
            uncertain: false,
          })
        : new HandoffPeerError({ code: "failed", message: String(error), uncertain: false });
    const peers = {
      linkedDigest: (environmentId: EnvironmentId, request: LinkedDigestRequest) => {
        const target = byEnv(environmentId);
        const grant = target.issuedTo(seat.environmentId);
        if (grant === undefined || grant === "revoked" || !target.isOnline())
          return Effect.fail(
            new HandoffPeerError({ code: "needs_grant", message: "No grant.", uncertain: false }),
          );
        return linkedCopyFor(
          target.projects,
          target.environmentId,
          {
            sourceEnvironmentId: seat.environmentId,
            grant: grantOf(seat.environmentId, grant),
            runtimeCeiling: "full-access",
            cloudUserId: USER,
          },
          request.projectId,
          request.logicalProjectId,
          USER,
          request.forProjectId,
        ).pipe(
          Effect.flatMap((project) => {
            const member = project.workspaceSettings!.logicalProject!.members.find(
              (entry) =>
                entry.environmentId === target.environmentId && entry.projectId === project.id,
            )!;
            return describeOn(target, project, member);
          }),
          Effect.mapError(asPeerError),
        );
      },
      memoryExport: (environmentId: EnvironmentId, request: Patch) => {
        const { forProjectId: _caller, ...rest } = request;
        return byEnv(environmentId)
          .memory.memoryExport(rest as any)
          .pipe(Effect.mapError(asPeerError));
      },
      memoryMerge: (environmentId: EnvironmentId, request: Patch) =>
        byEnv(environmentId)
          .memory.memoryMerge(request as any)
          .pipe(Effect.mapError(asPeerError)),
      reachable: () => Effect.succeed(true),
    } as unknown as LinkedPeerSyncDeps["peers"];
    const deps: LinkedPeerSyncDeps = {
      selfEnvironmentId: seat.environmentId,
      selfLabel: Effect.succeed(seat.label),
      listProjects: Effect.sync(() => [seat.current()]),
      targets: Effect.succeed(
        others.map((other) => ({
          machineId: other.environmentId,
          environmentId: other.environmentId,
          label: other.label,
        })),
      ),
      state: yield* LinkedPeerSyncState.make,
      isHeld: Effect.succeed(false),
      describe: (project, member) => describeOn(seat, project, member) as any,
      content: () => Effect.die("no content for a personal seat"),
      replicate: () => Effect.die("no replica for a personal seat"),
      giveWay: () => Effect.die("no give way for a personal seat"),
      adoptMembers: () => Effect.die("no member lists for a personal seat"),
      addPredecessorMembers: () => Effect.die("no member lists for a personal seat"),
      ...personalPeerSyncDeps(seat.projects, seat.environment),
      personalReach: seat.engine.reach,
      memory: seat.memory,
      plans: {
        exportLinked: ({ projectId }) =>
          Effect.fail(new ProjectPlanError({ projectId, code: "read_only" })),
        mergeLinked: () => Effect.succeed({} as never),
      },
      peers,
    };
    const sync = yield* makeLinkedPeerSync(deps);
    yield* sync.tick;
  });

/**
 * The server's minute, `rounds` times: every seat's reconciler, then every
 * seat's linked-sync pass, then the clock moves on.
 */
export const serverRounds = (seats: ReadonlyArray<ShareSeat>, rounds: number) =>
  Effect.gen(function* () {
    for (let round = 0; round < rounds; round += 1) {
      for (const seat of seats) yield* seat.reconciler.tick;
      for (const seat of seats) yield* linkedTick(seat, seats);
      yield* TestClock.adjust("1 minute");
    }
  });
