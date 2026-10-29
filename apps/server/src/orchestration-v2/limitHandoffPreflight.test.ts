// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * A limit handoff whose preflight fails (0968 T-10, AC-11): the limit port over
 * 0967's real moves and receiver, two machines in one process, real Git. The
 * thread stays on the source with the destination's exact reasons: no lease or
 * epoch change, no interrupt, no takeover, no continuation, no link, no note.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type HandoffCheckpoint,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  threadTurnKey,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import { writeCheckpoint } from "../handoff/checkpointGit.ts";
import { HandoffMode } from "../handoff/HandoffMode.ts";
import * as HandoffMoves from "../handoff/HandoffMoves.ts";
import { HandoffPeerError, HandoffPeers } from "../handoff/handoffPeers.ts";
import * as HandoffReceiver from "../handoff/HandoffReceiver.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  findIncoming,
  type HandoffDocument,
} from "../handoff/handoffState.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeLimitHandoffPort } from "./LimitHandoffAdapter.ts";
import type { LimitHandoffRequest } from "./MachineLimitHandoff.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Limit Test", "-c", "user.email=limit@example.invalid", "-C", cwd, ...args],
    { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const m4 = EnvironmentId.make("env-m4");
const minis = EnvironmentId.make("env-minis");
const sourceProject = ProjectId.make("project-m4");
const destinationProject = ProjectId.make("project-minis");
const threadId = ThreadId.make("thread:limit-preflight");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

interface Machine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  document: HandoffDocument;
  readonly launches: Array<unknown>;
  readonly dispatched: Array<{ readonly type: string }>;
}

const machine = (environmentId: EnvironmentId, label: string): Machine => ({
  environmentId,
  label,
  document: EMPTY_HANDOFF_DOCUMENT,
  launches: [],
  dispatched: [],
});

/** The source on M4 with a turn still running, and Minis lacking `.env.local` and Claude. */
const scenario = (options: { readonly modeOn: boolean }) =>
  Effect.gen(function* () {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-limit-preflight-")),
    );
    temporary.push(base);
    const sourceRoot = NodePath.join(base, "m4-repo");
    NodeFS.mkdirSync(sourceRoot);
    git(sourceRoot, "init", "-q", "-b", "feat/limit");
    NodeFS.writeFileSync(NodePath.join(sourceRoot, ".gitignore"), ".env.local\n");
    NodeFS.writeFileSync(NodePath.join(sourceRoot, "app.ts"), "export const a = 1;\n");
    git(sourceRoot, "add", "-A");
    git(sourceRoot, "commit", "-q", "-m", "base");
    const destinationRoot = NodePath.join(base, "minis-repo");
    git(base, "clone", "-q", sourceRoot, destinationRoot);
    NodeFS.writeFileSync(NodePath.join(sourceRoot, "app.ts"), "export const a = 2;\n");
    NodeFS.writeFileSync(NodePath.join(sourceRoot, ".env.local"), "TOKEN=source\n");
    const worktreesDir = NodePath.join(base, "minis-worktrees");

    const source = machine(m4, "M4");
    const destination = machine(minis, "Minis");
    const fixture = { activeRunId: "run-1" as string | null, sequence: 0 };
    const takeovers: Array<unknown> = [];

    const handoffFor = (target: Machine) =>
      ({
        environmentId: target.environmentId,
        machineLabel: target.label,
        document: Effect.sync(() => target.document),
        updateDocument: <A>(change: (document: HandoffDocument) => readonly [A, HandoffDocument]) =>
          Effect.sync(() => {
            const [result, next] = change(target.document);
            target.document = next;
            return result;
          }),
        snapshot: Effect.sync(() => ({}) as never),
        checkpoint: () =>
          Effect.promise(async () => {
            const written = await writeCheckpoint({ cwd: sourceRoot, threadId });
            fixture.sequence += 1;
            const record = target.document.threads[threadId] ?? emptyThreadRecord(sourceProject);
            const checkpoint: HandoffCheckpoint = {
              sequence: fixture.sequence,
              commit: written.commit,
              baseCommit: written.baseCommit,
              branch: written.branch,
              ref: written.ref,
              createdAt: "2026-10-20T14:00:00.000Z",
              reason: "handoff",
              skipped: [...written.skipped],
              excludedSecretCount: written.excludedSecretCount,
              requiredSecretPaths: [...written.requiredSecretPaths],
              transcriptMessageCount: 1,
              note: null,
              pushedToOrigin: false,
              epoch: record.lease?.epoch ?? 0,
              latestRunId: null,
              turnKey: threadTurnKey(threadId, "run-1"),
              runEnding: fixture.activeRunId === null ? "usage-limit" : "active",
              sideEffects: [],
              sourceRoot: {
                environmentId: m4,
                machineLabel: "M4",
                projectId: sourceProject,
                threadId,
                workspaceRoot: written.root,
                branch: written.branch,
              },
            };
            target.document = {
              ...target.document,
              threads: { ...target.document.threads, [threadId]: { ...record, checkpoint } },
            };
            return checkpoint;
          }),
      }) as unknown as HandoffMode["Service"];

    const projectOf = (target: Machine, roots: { project: ProjectId; root: string }) => ({
      id: roots.project,
      title: "App",
      workspaceRoot: roots.root,
      workspaceSettings:
        target === destination
          ? { logicalProject: { members: [{ environmentId: m4, projectId: sourceProject }] } }
          : undefined,
    });

    const servicesFor = (target: Machine, roots: { project: ProjectId; root: string }) =>
      Layer.mergeAll(
        Layer.succeed(HandoffMode, handoffFor(target)),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        } as never),
        Layer.succeed(ServerConfig.ServerConfig, { worktreesDir } as never),
        Layer.succeed(ProjectService.ProjectService, {
          getById: (id: ProjectId) =>
            Effect.succeed(
              id === roots.project ? Option.some(projectOf(target, roots)) : Option.none(),
            ),
          snapshot: Effect.succeed({ projects: [projectOf(target, roots)] }),
        } as never),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              displayName: "Claude",
              enabled: true,
              installed: true,
              auth: { status: "unauthenticated" },
              models: [{ slug: "claude-opus-5-5" }],
            },
          ]),
        } as never),
        Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
          launch: (input: unknown) => Effect.sync(() => void target.launches.push(input)),
        } as never),
        Layer.succeed(Orchestrator.OrchestratorV2, {
          dispatch: (command: { type: string }) =>
            Effect.sync(() => {
              target.dispatched.push(command);
              if (command.type === "run.interrupt") fixture.activeRunId = null;
              return {};
            }),
        } as never),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThreadShell: (id: ThreadId) =>
            Effect.succeed(
              id === threadId
                ? {
                    id: threadId,
                    projectId: sourceProject,
                    title: "Fix the build",
                    worktreePath: null,
                    activeRunId: fixture.activeRunId,
                    latestRunId: null,
                    modelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    deletedAt: null,
                  }
                : null,
            ),
          getThread: () => Effect.succeed({ execution: null }),
          getThreadRecords: () =>
            Effect.succeed({
              messages: [{ role: "user", text: "Fix the build", streaming: false }],
            }),
        } as never),
      );

    const destinationReceiver = yield* HandoffReceiver.make.pipe(
      Effect.provide(
        servicesFor(destination, { project: destinationProject, root: destinationRoot }),
      ),
    );
    const asSource = { sourceEnvironmentId: m4, grant: unscopedGrant(m4) };
    const viaNetwork = <A>(effect: Effect.Effect<A, HandoffReceiver.HandoffRefusal>) =>
      effect.pipe(
        Effect.mapError(
          (refusal) =>
            new HandoffPeerError({
              code: refusal.code,
              message: refusal.message,
              check: refusal.check,
              uncertain: false,
            }),
        ),
      );
    const peers = HandoffPeers.of({
      target: () => Effect.succeed({ machineId: "minis", environmentId: minis, label: "Minis" }),
      targets: Effect.succeed([{ machineId: "minis", environmentId: minis, label: "Minis" }]),
      negotiate: (_, request) => viaNetwork(destinationReceiver.negotiate(asSource, request)),
      replicate: (_, meta, bundle) =>
        viaNetwork(destinationReceiver.replicate(asSource, meta, bundle)),
      preflight: (_, request) => viaNetwork(destinationReceiver.preflight(asSource, request)),
      takeover: (_, request) => {
        takeovers.push(request);
        return viaNetwork(destinationReceiver.takeover(asSource, request));
      },
      heartbeat: (_, request) => viaNetwork(destinationReceiver.heartbeat(asSource, request)),
      coordinatorLease: () => Effect.die("unused"),
      coordinatorReplica: () => Effect.die("unused"),
    });
    const moves = yield* Effect.gen(function* () {
      const receiver = yield* HandoffReceiver.make;
      return yield* HandoffMoves.make.pipe(
        Effect.provideService(HandoffReceiver.HandoffReceiver, receiver),
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          servicesFor(source, { project: sourceProject, root: sourceRoot }),
          Layer.succeed(HandoffPeers, peers),
        ),
      ),
    );
    if (options.modeOn) {
      source.document = {
        ...source.document,
        threads: {
          [threadId]: {
            ...emptyThreadRecord(sourceProject),
            mode: "on",
            lease: {
              holderEnvironmentId: m4,
              holderLabel: "M4",
              holderThreadId: threadId,
              epoch: 1,
              renewedAt: "2026-10-20T14:00:00.000Z",
              state: "active",
            },
          },
        },
      };
    }
    const notes: Array<unknown> = [];
    const port = makeLimitHandoffPort({
      environmentId: m4,
      document: Effect.sync(() => source.document),
      handOff: moves.handOff,
      recordNote: (input) => Effect.sync(() => void notes.push(input)),
    });
    return { source, destination, fixture, takeovers, notes, port };
  });

const request: LimitHandoffRequest = {
  threadId,
  projectId: sourceProject,
  destinationEnvironmentId: minis,
  destinationLabel: "Minis",
  modelSelection,
  reason: "usage-limit",
  resume: true,
  idempotencyKey: "limit-handoff:thread:limit-preflight:run-1",
  sourceSummary: "Claude limit reached on M4",
  modelLabel: "Claude Opus 5.5",
};

/**
 * Everything a move would change on a source record. Only the "handoff"
 * checkpoint and its replica may be new (a thread with handoff mode off gets
 * its first record from that checkpoint).
 */
const moveState = (document: HandoffDocument) => {
  const record = document.threads[threadId] ?? emptyThreadRecord(sourceProject);
  return {
    mode: record.mode,
    lease: record.lease,
    fencedBy: record.fencedBy,
    continuedOn: record.continuedOn,
    lastError: record.lastError,
  };
};

describe("a limit handoff whose preflight fails", () => {
  for (const modeOn of [true, false]) {
    it.effect(
      `keeps the thread on the source with the exact reasons (handoff mode ${modeOn ? "on" : "off"})`,
      () =>
        Effect.gen(function* () {
          const { source, destination, fixture, takeovers, notes, port } = yield* scenario({
            modeOn,
          });
          const before = structuredClone(moveState(source.document));

          const outcome = yield* port.handOff(request);

          // The destination's reasons, every one, joined as 0967 gives them.
          expect(outcome).toEqual({
            type: "refused",
            code: "invalid",
            message: "Minis: no .env.local; Minis: Claude not signed in",
            retryable: false,
          });
          // No lease, epoch, fence or error change on the source.
          expect(moveState(source.document)).toEqual(before);
          if (modeOn) {
            expect(source.document.threads[threadId]?.lease).toEqual({
              holderEnvironmentId: m4,
              holderLabel: "M4",
              holderThreadId: threadId,
              epoch: 1,
              renewedAt: "2026-10-20T14:00:00.000Z",
              state: "active",
            });
          } else {
            expect(source.document.threads[threadId]?.lease ?? null).toBeNull();
          }
          // The running turn kept running; nothing was recorded on the thread.
          expect(fixture.activeRunId).toBe("run-1");
          expect(source.dispatched).toEqual([]);
          expect(notes).toEqual([]);
          // No half-move: no takeover was sent and nothing continues on Minis.
          expect(takeovers).toEqual([]);
          expect(destination.launches).toEqual([]);
          expect(destination.dispatched).toEqual([]);
          expect(findIncoming(destination.document, m4, threadId)?.continuedThreadId ?? null).toBe(
            null,
          );
          expect(
            Object.values(destination.document.threads).filter((record) => record.lease !== null),
          ).toEqual([]);

          // Asking again changes nothing either: the refusal is the same, still before any move.
          expect(yield* port.handOff(request)).toEqual(outcome);
          expect(moveState(source.document)).toEqual(before);
          expect(takeovers).toEqual([]);
        }),
    );
  }
});
