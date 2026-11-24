// @effect-diagnostics anyUnknownInErrorContext:off -- the seat harness stubs services with loosely typed fakes.
/**
 * Three linked personal assistant seats end to end, in process (1448 C1-C4):
 * each seat has its own database, memory store, `PersonalLinkService`,
 * `LinkedMemorySync` and `LinkedPeerSync`; the seats reach each other through
 * the real route gate (`linkedCopyFor`) and digest (`describeCopy`). Only the
 * project row store and the database copy are stand-ins.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  EventId,
  type LogicalProjectMember,
  PERSONAL_LINK_PROTOCOL_VERSION,
  type Project,
  ProjectId,
  ProjectPlanError,
  ThreadId,
} from "@specweave-studio/contracts";
import { renamedMemoryName } from "@specweave-studio/shared/personalAssistantMigration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import { HandoffRefusal } from "../handoff/HandoffReceiver.ts";
import { HandoffPeerError } from "../handoff/handoffPeers.ts";
import type { LinkedDigestRequest } from "../handoff/linkedSyncWire.ts";
import { ownershipRejection, sharedStampIsNewer } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import * as LinkedMemorySync from "./LinkedMemorySync.ts";
import { describeCopy, linkedCopyFor } from "./LinkedPeerRoute.ts";
import { type LinkedPeerSyncDeps, makeLinkedPeerSync } from "./LinkedPeerSync.ts";
import * as LinkedPeerSyncState from "./LinkedPeerSyncState.ts";
import * as PersonalLinkService from "./PersonalLinkService.ts";
import { personalPeerSyncDeps } from "./PersonalPeerSync.ts";
import { PersonalLinkSnapshot } from "./personalLinkSnapshot.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";

const USER = "user_owner_1";
const TRIO = "logical:percy-trio";
const PAIR = "logical:percy-pair";

const memberOf = (name: string): LogicalProjectMember => {
  const projectId = ProjectId.make(`percy-${name}`);
  return {
    environmentId: EnvironmentId.make(`env-${name}`),
    projectId,
    coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
  };
};

const grantFor = (environmentId: EnvironmentId) =>
  ({
    coordinatorEnvironmentId: environmentId,
    kind: "own",
    owner: "self",
    legacy: false,
    revoked: false,
    maxRuntimeMode: "full-access",
    projects: { kind: "none" },
    accounts: { kind: "all" },
  }) as unknown as EffectiveWorkGrant;

type Patch = Record<string, any>;

/** One machine: a personal assistant row, real memory store, link and sync services. */
const makeSeat = (name: string, label: string) =>
  Effect.gen(function* () {
    const self = memberOf(name);
    let project: Project = {
      id: self.projectId,
      title: "Percy",
      workspaceRoot: `/tmp/${self.projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      deletedAt: null,
      faviconPath: null,
      projectIcon: { kind: "lucide", name: "sparkles", color: "violet" },
      workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, kind: "personal", revision: 1 },
    };
    const refusals: string[] = [];

    const update = (input: Patch) =>
      Effect.suspend(() => {
        const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
        const expected =
          input.ownership?.expectedRevision ?? input.workspaceSettings?.expectedRevision;
        const reject = (message: string) => {
          refusals.push(message);
          return Effect.fail({ _tag: "ProjectSettingsRevisionConflictError", message } as any);
        };
        if (expected !== undefined && expected !== settings.revision) return reject("revision");
        if (input.ownership) {
          const rejection = ownershipRejection(project.id, settings, input.ownership);
          if (rejection !== undefined) return reject(rejection);
        }
        if (
          input.sharedSettingsStamp !== undefined &&
          !sharedStampIsNewer(input.sharedSettingsStamp, settings.sharedSettingsUpdatedAt)
        )
          return reject("stamp not newer");
        const { expectedRevision: _ignored, ...patch } = input.workspaceSettings ?? {};
        project = {
          ...project,
          title: input.title ?? project.title,
          projectIcon: input.projectIcon !== undefined ? input.projectIcon : project.projectIcon,
          workspaceSettings: {
            ...settings,
            ...patch,
            ...(input.sharedSettingsStamp !== undefined
              ? { sharedSettingsUpdatedAt: input.sharedSettingsStamp }
              : {}),
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
      });

    const projects = {
      getById: (id: ProjectId) =>
        Effect.sync(() => (id === project.id ? Option.some(project) : Option.none())),
      snapshot: Effect.sync(() => ({ projects: [project] })),
      update,
    } as unknown as ProjectService.ProjectService["Service"];
    const environment = {
      getEnvironmentId: Effect.succeed(self.environmentId),
      getDescriptor: Effect.succeed({
        environmentId: self.environmentId,
        label,
        platform: { os: "darwin", arch: "arm64" },
      }),
    } as unknown as ServerEnvironment.ServerEnvironment["Service"];

    const storage = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
    const workspace = Workspace.layer.pipe(
      Layer.provideMerge(Layer.merge(storage, LinkedMemoryHistory.layerMemory)),
    );
    const base = Layer.mergeAll(
      workspace,
      Layer.succeed(ServerEnvironment.ServerEnvironment, environment),
      Layer.succeed(ProjectService.ProjectService, projects),
      Layer.succeed(PersonalLinkSnapshot, {
        snapshot: (operationId: string) => Effect.succeed(`/tmp/backups/${operationId}.sqlite`),
      }),
    );
    const layer = Layer.mergeAll(LinkedMemorySync.layer, PersonalLinkService.layer).pipe(
      Layer.provideMerge(base),
    );
    const context = yield* Layer.buildWithMemoMap(
      layer,
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
          eventId: EventId.make(`event:${self.projectId}`),
          aggregateKind: "project",
          aggregateId: self.projectId,
          occurredAt: "2026-11-01T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId: self.projectId,
            title: "Percy",
            workspaceRoot: `/tmp/${self.projectId}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
          },
        } as any);
      }),
    );

    const write = (file: string, content: string) =>
      run(
        Effect.gen(function* () {
          const service = yield* Workspace.ProjectWorkspaceService;
          const current = yield* service
            .readMemory({ projectId: self.projectId, name: file })
            .pipe(Effect.option);
          return yield* service.writeMemory({
            projectId: self.projectId,
            name: file,
            content,
            expectedRevision: Option.isSome(current) ? current.value.revision : null,
          });
        }),
      );
    const contents = run(
      Effect.gen(function* () {
        const service = yield* Workspace.ProjectWorkspaceService;
        const result: Record<string, string> = {};
        for (const file of yield* service.readMemoryFiles({ projectId: self.projectId }))
          result[file.name] = file.content;
        return result;
      }),
    );
    const tombstones = run(
      Effect.gen(function* () {
        const histories = yield* LinkedMemoryHistory.LinkedMemoryHistory;
        return Object.keys((yield* histories.read(self.projectId)).tombstones).toSorted();
      }),
    );
    const link = run(Effect.service(PersonalLinkService.PersonalLinkService));
    const memory = run(Effect.service(LinkedMemorySync.LinkedMemorySync));
    const join = (input: Patch) =>
      Effect.gen(function* () {
        const service = yield* link;
        const preview = yield* service.preview({ projectId: self.projectId });
        return yield* service.join({
          projectId: self.projectId,
          routineOwner: true,
          peerProtocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
          approval: {
            expectedSettingsRevision: preview.settingsRevision!,
            memoryDigest: preview.memoryDigest!,
          },
          ...input,
        } as any);
      });
    const leave = link.pipe(
      Effect.flatMap((service) => service.leave({ projectId: self.projectId })),
    );
    /** The owner edits the shared settings on this seat. */
    const edit = (changes: { title?: string; instructions?: string }, at: string) =>
      Effect.sync(() => {
        const settings = project.workspaceSettings!;
        project = {
          ...project,
          title: changes.title ?? project.title,
          workspaceSettings: {
            ...settings,
            ...(changes.instructions !== undefined ? { instructions: changes.instructions } : {}),
            sharedSettingsUpdatedAt: at,
            revision: settings.revision + 1,
          },
        };
      });

    return {
      self,
      label,
      projects,
      environment,
      memory,
      run,
      write,
      contents,
      tombstones,
      join,
      leave,
      edit,
      refusals,
      current: () => project,
      identity: () => project.workspaceSettings?.logicalProject,
      binding: () => project.workspaceSettings?.coordinatorBinding,
    };
  });

type Seat = Effect.Success<ReturnType<typeof makeSeat>>;

const asPeerError = (error: unknown) =>
  error instanceof HandoffRefusal
    ? new HandoffPeerError({
        code: error.code,
        message: error.message,
        check: error.check,
        uncertain: false,
      })
    : new HandoffPeerError({ code: "failed", message: String(error), uncertain: false });

/** A fresh `LinkedPeerSync` for `seat`, calling the other seats in process. */
const tick = (seat: Seat, all: ReadonlyArray<Seat>) =>
  Effect.gen(function* () {
    const others = all.filter((other) => other !== seat);
    const byEnv = (environmentId: EnvironmentId) =>
      others.find((other) => other.self.environmentId === environmentId)!;
    const describeOn = (target: Seat, project: Project, member: LogicalProjectMember) =>
      Effect.gen(function* () {
        const memory = yield* target.memory;
        return yield* describeCopy(
          {
            link: { digest: () => Effect.die("no coordinator digest for a personal seat") },
            memory,
            plans: {
              exportLinked: ({ projectId }) =>
                Effect.fail(new ProjectPlanError({ projectId, code: "read_only" })),
            },
          },
          project,
          member,
        );
      });
    const peers = {
      linkedDigest: (environmentId: EnvironmentId, request: LinkedDigestRequest) => {
        const target = byEnv(environmentId);
        return linkedCopyFor(
          target.projects,
          target.self.environmentId,
          {
            sourceEnvironmentId: seat.self.environmentId,
            grant: grantFor(seat.self.environmentId),
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
                entry.environmentId === target.self.environmentId && entry.projectId === project.id,
            )!;
            return describeOn(target, project, member);
          }),
          Effect.mapError(asPeerError),
        );
      },
      memoryExport: (environmentId: EnvironmentId, request: Patch) =>
        byEnv(environmentId).memory.pipe(
          Effect.flatMap((service) => {
            const { forProjectId: _caller, ...rest } = request;
            return service.memoryExport(rest as any);
          }),
          Effect.mapError(asPeerError),
        ),
      memoryMerge: (environmentId: EnvironmentId, request: Patch) =>
        byEnv(environmentId).memory.pipe(
          Effect.flatMap((service) => service.memoryMerge(request as any)),
          Effect.mapError(asPeerError),
        ),
      reachable: () => Effect.succeed(true),
    } as unknown as LinkedPeerSyncDeps["peers"];
    const memory = yield* seat.memory;
    const deps: LinkedPeerSyncDeps = {
      selfEnvironmentId: seat.self.environmentId,
      selfLabel: Effect.succeed(seat.label),
      listProjects: Effect.sync(() => [seat.current()]),
      targets: Effect.succeed(
        others.map((other) => ({
          machineId: other.self.environmentId,
          environmentId: other.self.environmentId,
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
      memory,
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

/** Every seat runs one pass, in turn, `rounds` times. */
const passes = (seats: ReadonlyArray<Seat>, rounds = 2) =>
  Effect.gen(function* () {
    for (let round = 0; round < rounds; round += 1) {
      for (const seat of seats) yield* tick(seat, seats);
      yield* TestClock.adjust("1 minute");
    }
  });

const membersOf = (seat: Seat) =>
  (seat.identity()?.members ?? []).map((member) => member.environmentId).toSorted();

const trioMembers = (seats: ReadonlyArray<Seat>) => seats.map((seat) => seat.self);

/** Three seats with their own memory; A and C both hold a different prefs.md. */
const threeSeats = Effect.gen(function* () {
  const a = yield* makeSeat("a", "Alpha");
  const b = yield* makeSeat("b", "Beta");
  const c = yield* makeSeat("c", "Gamma");
  yield* a.write("prefs.md", "Alpha prefers short replies.");
  yield* a.write("alpha-only.md", "Alpha notes.");
  yield* b.write("beta-only.md", "Beta notes.");
  yield* c.write("prefs.md", "Gamma prefers long replies.");
  yield* c.write("gamma-only.md", "Gamma notes.");
  return [a, b, c] as const;
});

/** Links all three on TRIO; A renames its clashing prefs.md as a shared copy. */
const linkTrio = (seats: ReadonlyArray<Seat>) =>
  Effect.gen(function* () {
    const [a, b, c] = seats;
    const members = trioMembers(seats);
    yield* a!.join({
      logicalProjectId: TRIO,
      members,
      operationId: "op-trio",
      memoryResolutions: [{ name: "prefs.md", action: "rename-shared" }],
    });
    yield* b!.join({ logicalProjectId: TRIO, members, operationId: "op-trio" });
    yield* c!.join({ logicalProjectId: TRIO, members, operationId: "op-trio" });
    yield* TestClock.adjust("1 minute");
  });

const ALL = ["env-a", "env-b", "env-c"];

describe("three linked personal assistant seats", () => {
  it.effect("a clash rename and memory sync in every direction lose no file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seats = yield* threeSeats;
        yield* linkTrio(seats);
        const renamed = renamedMemoryName("prefs.md", "Alpha", "env-a");
        assert.notStrictEqual(renamed, "prefs.md");
        for (const seat of seats) assert.deepStrictEqual(membersOf(seat), ALL);

        yield* passes(seats, 3);

        const expected = {
          "alpha-only.md": "Alpha notes.",
          "beta-only.md": "Beta notes.",
          "gamma-only.md": "Gamma notes.",
          "prefs.md": "Gamma prefers long replies.",
          [renamed]: "Alpha prefers short replies.",
        };
        for (const seat of seats) {
          assert.deepStrictEqual(yield* seat.contents, expected, `memory on ${seat.label}`);
          assert.notInclude(yield* seat.tombstones, "prefs.md", `tombstones on ${seat.label}`);
          assert.deepStrictEqual(membersOf(seat), ALL);
        }
      }),
    ),
  );

  it.effect("settings edited on each seat in turn reach all three, both ways round a pair", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Peer stamps more than ten minutes ahead of the clock are ignored: set it to their day.
        yield* TestClock.setTime(Date.parse("2026-11-23T12:30:00.000Z"));
        const seats = yield* threeSeats;
        const [a, b, c] = seats;
        yield* linkTrio(seats);
        const shared = (seat: Seat) => ({
          title: seat.current().title,
          instructions: seat.current().workspaceSettings?.instructions,
          stamp: seat.current().workspaceSettings?.sharedSettingsUpdatedAt,
        });

        // A edits; C, which never drives a pair, pulls it from A, then B from either.
        yield* a.edit({ title: "Jarvis" }, "2026-11-23T10:00:00.000Z");
        yield* tick(c, seats);
        assert.strictEqual(c.current().title, "Jarvis");
        yield* tick(b, seats);
        assert.strictEqual(b.current().title, "Jarvis");

        // B edits; A pulls it on its own pass as the driver, C on its pass.
        yield* b.edit({ instructions: "Answer in English." }, "2026-11-23T11:00:00.000Z");
        yield* tick(a, seats);
        assert.strictEqual(a.current().workspaceSettings?.instructions, "Answer in English.");
        yield* tick(c, seats);
        assert.strictEqual(c.current().workspaceSettings?.instructions, "Answer in English.");

        // C edits; A and B each pull it from C.
        yield* c.edit(
          { title: "Percy", instructions: "Keep replies short." },
          "2026-11-23T12:00:00.000Z",
        );
        yield* tick(a, seats);
        yield* tick(b, seats);
        yield* passes(seats, 1);

        for (const seat of seats)
          assert.deepStrictEqual(
            shared(seat),
            {
              title: "Percy",
              instructions: "Keep replies short.",
              stamp: "2026-11-23T12:00:00.000Z",
            },
            `settings on ${seat.label}`,
          );
        for (const seat of seats) assert.deepStrictEqual(membersOf(seat), ALL);
      }),
    ),
  );

  it.effect("a seat that leaves is dropped by the other two only, and taken back on relink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seats = yield* threeSeats;
        const [a, b, c] = seats;
        yield* linkTrio(seats);
        yield* passes(seats, 1);

        const left = yield* c.leave;
        assert.isTrue(left.unlinked);
        assert.notStrictEqual(c.identity()?.id, TRIO);
        assert.strictEqual(c.binding()?.formerLinks?.at(-1)?.logicalProjectId, TRIO);
        yield* TestClock.adjust("1 minute");

        yield* passes(seats, 2);
        for (const seat of [a, b]) {
          assert.strictEqual(seat.identity()?.id, TRIO, `${seat.label} stays on the link`);
          assert.deepStrictEqual(membersOf(seat), ["env-a", "env-b"], `members on ${seat.label}`);
          assert.include(
            (seat.binding()?.removedMembers ?? []).map((entry) => entry.environmentId),
            c.self.environmentId,
          );
        }
        assert.deepStrictEqual(membersOf(c), ["env-c"]);

        // C links again to the same id; the seats already on it join first (C2).
        const members = trioMembers(seats);
        yield* a.join({ logicalProjectId: TRIO, members, operationId: "op-relink" });
        yield* b.join({ logicalProjectId: TRIO, members, operationId: "op-relink" });
        yield* c.join({ logicalProjectId: TRIO, members, operationId: "op-relink" });
        assert.notInclude(
          (c.binding()?.formerLinks ?? []).map((entry) => entry.logicalProjectId),
          TRIO,
        );
        yield* TestClock.adjust("1 minute");

        yield* passes(seats, 3);
        for (const seat of seats) {
          assert.strictEqual(seat.identity()?.id, TRIO, `${seat.label} on the link`);
          assert.deepStrictEqual(membersOf(seat), ALL, `members on ${seat.label}`);
        }
      }),
    ),
  );

  it.effect("a third machine joins an existing pair under the pair's link id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seats = yield* threeSeats;
        const [a, b, c] = seats;
        const pair = [a.self, b.self];
        yield* a.join({
          logicalProjectId: PAIR,
          canonicalName: "Percy",
          members: pair,
          operationId: "op-pair",
        });
        yield* b.join({ logicalProjectId: PAIR, members: pair, operationId: "op-pair" });
        yield* TestClock.adjust("1 minute");
        yield* passes([a, b], 1);

        const members = trioMembers(seats);
        const onA = yield* a.join({
          logicalProjectId: PAIR,
          canonicalName: "Another name",
          members,
          operationId: "op-pair",
          memoryResolutions: [{ name: "prefs.md", action: "rename-shared" }],
        });
        const onB = yield* b.join({ logicalProjectId: PAIR, members, operationId: "op-pair" });
        const onC = yield* c.join({ logicalProjectId: PAIR, members, operationId: "op-pair" });
        for (const result of [onA, onB, onC]) {
          assert.strictEqual(result.logicalProject.id, PAIR);
          assert.strictEqual(result.logicalProject.members.length, 3);
        }
        // Extending the link keeps its name on the seats already on it.
        assert.strictEqual(a.identity()?.title, "Percy");
        assert.strictEqual(a.current().title, "Percy");
        yield* TestClock.adjust("1 minute");

        yield* passes(seats, 3);
        for (const seat of seats) {
          assert.strictEqual(seat.identity()?.id, PAIR);
          assert.deepStrictEqual(membersOf(seat), ALL, `members on ${seat.label}`);
          assert.deepStrictEqual(
            Object.keys(yield* seat.contents).toSorted(),
            [
              "alpha-only.md",
              "beta-only.md",
              "gamma-only.md",
              "prefs.md",
              renamedMemoryName("prefs.md", "Alpha", "env-a"),
            ].toSorted(),
            `memory on ${seat.label}`,
          );
        }
      }),
    ),
  );
});
