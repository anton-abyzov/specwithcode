// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures for the takeover cases.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  HANDOFF_LEASE_STALE_MS,
  type HandoffCheckpoint,
  type ModelSelection,
  ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  type EffectiveWorkGrant,
  unscopedGrant,
  type WorkOrigin,
} from "../fleet/workGrantPolicy.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { writeCheckpoint } from "./checkpointGit.ts";
import { HandoffMode } from "./HandoffMode.ts";
import * as HandoffReceiver from "./HandoffReceiver.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  findIncoming,
  HANDOFF_INCOMING_MAX,
  HandoffDocument,
  type HandoffDocument as Document,
  heartbeatContinued,
  incomingKey,
  linkedLocalProject,
  markContinued,
  markUnreachable,
  takeoverVerdict,
  upsertIncoming,
} from "./handoffState.ts";
import {
  HANDOFF_APP_VERSION,
  HANDOFF_PROTOCOL_VERSION,
  type ReplicateMeta,
  type TakeoverRequest,
  type TakeoverResponse,
} from "./handoffWire.ts";

class LaunchRefusedError extends Schema.TaggedError<LaunchRefusedError>()("LaunchRefusedError", {
  message: Schema.String,
}) {}

const m4 = EnvironmentId.make("env-m4");
const minis = EnvironmentId.make("env-minis");
const sourceProject = ProjectId.make("project-src");
const localProject = ProjectId.make("project-local");
const sourceThread = ThreadId.make("thread-src");
const now = "2026-10-20T14:00:00.000Z";
const later = "2026-10-20T14:05:00.000Z";

const checkpoint = (sequence: number, epoch = 1): HandoffCheckpoint => ({
  sequence,
  commit: "a".repeat(40),
  baseCommit: "b".repeat(40),
  branch: "feat/x",
  ref: `refs/specwithcode/handoff/${sourceThread}`,
  createdAt: now,
  reason: "turn-end",
  skipped: [],
  excludedSecretCount: 0,
  transcriptMessageCount: 2,
  note: null,
  pushedToOrigin: false,
  epoch,
  latestRunId: null,
  turnKey: `${sourceThread}/run-1`,
  runEnding: "usage-limit",
  sideEffects: [],
  sourceRoot: {
    environmentId: m4,
    projectId: sourceProject,
    threadId: sourceThread,
    workspaceRoot: "/repo",
    branch: "feat/x",
  },
});

const meta = (sequence: number, epoch = 1, threadId = sourceThread): ReplicateMeta => ({
  sourceEnvironmentId: m4,
  sourceLabel: "M4",
  sourceProjectId: sourceProject,
  sourceThreadId: threadId,
  repositoryPath: "",
  title: "Fix the build",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5.5" } as never,
  runtimeMode: "full-access",
  interactionMode: "default",
  checkpoint: checkpoint(sequence, epoch),
  lease: {
    holderEnvironmentId: m4,
    holderLabel: "M4",
    holderThreadId: threadId,
    epoch,
    renewedAt: now,
    state: "active",
  },
  transcript: [{ role: "user", text: "Fix the build" }],
  execution: null,
});

const stored = (document: Document, input: ReplicateMeta): Document => {
  const verdict = upsertIncoming(document, {
    meta: input,
    projectId: localProject,
    machineLabel: "Minis",
    now,
  });
  if (verdict.kind !== "stored") throw new Error(verdict.message);
  return verdict.document;
};

const takeover = (overrides: Partial<TakeoverRequest> = {}): TakeoverRequest => ({
  sourceEnvironmentId: m4,
  sourceThreadId: sourceThread,
  epoch: 2,
  sequence: 3,
  reason: "machine-handoff",
  modelSelection: null,
  ...overrides,
});

const response: TakeoverResponse = {
  threadId: ThreadId.make("thread-dest"),
  machineLabel: "Minis",
  modelSelection: null,
  resumed: true,
  notice: null,
};

const encodeDocument = Schema.encodeSync(HandoffDocument);
const decodeDocument = Schema.decodeUnknownOption(HandoffDocument);

describe("incoming replicas", () => {
  it("stores the newest checkpoint and keeps a newer one over an older resend", () => {
    const first = stored(EMPTY_HANDOFF_DOCUMENT, meta(3));
    expect(findIncoming(first, m4, sourceThread)?.checkpoint.sequence).toBe(3);
    expect(first.incomingDetails?.[incomingKey(m4, sourceThread)]?.sourceProjectId).toBe(
      sourceProject,
    );
    const resent = upsertIncoming(first, {
      meta: meta(2),
      projectId: localProject,
      machineLabel: "Minis",
      now: later,
    });
    expect(resent.kind).toBe("stored");
    if (resent.kind !== "stored") return;
    const replica = findIncoming(resent.document, m4, sourceThread);
    expect(replica?.checkpoint.sequence).toBe(3);
    expect(replica?.sourceLastSeenAt).toBe(later);
  });

  it("refuses a replica of a thread this machine already continued", () => {
    const document = markContinued(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      takeover(),
      response,
      now,
    );
    const verdict = upsertIncoming(document, {
      meta: meta(4),
      projectId: localProject,
      machineLabel: "Minis",
      now,
    });
    expect(verdict).toMatchObject({ kind: "refused", code: "fenced" });
  });

  it("evicts replicas this machine never continued first", () => {
    let document = markContinued(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      takeover(),
      response,
      now,
    );
    for (let index = 0; index < HANDOFF_INCOMING_MAX; index += 1) {
      document = stored(document, meta(1, 1, ThreadId.make(`thread-${index}`)));
    }
    expect(document.incoming).toHaveLength(HANDOFF_INCOMING_MAX);
    expect(findIncoming(document, m4, sourceThread)?.continuedThreadId).toBe("thread-dest");
    expect(findIncoming(document, m4, ThreadId.make("thread-0"))).toBeUndefined();
    expect(document.incomingDetails?.[incomingKey(m4, "thread-0")]).toBeUndefined();
  });

  it("decodes a document written before incoming details existed", () => {
    const encoded = encodeDocument(EMPTY_HANDOFF_DOCUMENT) as Record<string, unknown>;
    const { incomingDetails: _dropped, ...older } = encoded;
    const decoded = decodeDocument(older);
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.getOrThrow(decoded).incomingDetails).toEqual({});
  });
});

describe("takeover", () => {
  const document = stored(EMPTY_HANDOFF_DOCUMENT, meta(3));

  it("proceeds at a newer epoch with the checkpoint in hand", () => {
    expect(takeoverVerdict(document, takeover(), "Minis").kind).toBe("proceed");
  });

  it("refuses without the checkpoint, naming the check", () => {
    expect(takeoverVerdict(EMPTY_HANDOFF_DOCUMENT, takeover(), "Minis")).toMatchObject({
      kind: "refuse",
      code: "not_found",
      check: "checkpoint",
      message: "Minis: no checkpoint for this thread",
    });
    expect(takeoverVerdict(document, takeover({ sequence: 4 }), "Minis")).toMatchObject({
      kind: "refuse",
      check: "checkpoint",
    });
  });

  it("refuses a stale epoch", () => {
    expect(takeoverVerdict(document, takeover({ epoch: 1 }), "Minis")).toMatchObject({
      kind: "refuse",
      code: "fenced",
      check: "lease",
    });
  });

  it("answers a repeated takeover with the same thread and refuses another epoch", () => {
    const continued = markContinued(document, takeover(), response, now);
    expect(takeoverVerdict(continued, takeover(), "Minis")).toEqual({ kind: "repeat", response });
    expect(takeoverVerdict(continued, takeover({ epoch: 3 }), "Minis")).toMatchObject({
      kind: "refuse",
      code: "fenced",
    });
  });
});

describe("heartbeat", () => {
  it("tells the source which threads this machine continued, whatever epoch it names", () => {
    const continued = markContinued(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      takeover(),
      response,
      now,
    );
    const [fenced, next] = heartbeatContinued(
      continued,
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 1 }] },
      later,
    );
    expect(fenced).toEqual([{ sourceThreadId: sourceThread, epoch: 2, threadId: "thread-dest" }]);
    expect(findIncoming(next, m4, sourceThread)?.sourceLastSeenAt).toBe(later);
    // A source that bumped its epoch after an unknown takeover outcome is still fenced.
    const [bumped] = heartbeatContinued(
      continued,
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 3 }] },
      later,
    );
    expect(bumped).toEqual([{ sourceThreadId: sourceThread, epoch: 2, threadId: "thread-dest" }]);
    const [none] = heartbeatContinued(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 2 }] },
      later,
    );
    expect(none).toEqual([]);
  });

  it("raises the replica's epoch to the one the source holds, refusing a delayed takeover", () => {
    const document = stored(EMPTY_HANDOFF_DOCUMENT, meta(3));
    const [, next] = heartbeatContinued(
      document,
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 3 }] },
      later,
    );
    expect(findIncoming(next, m4, sourceThread)?.lease.epoch).toBe(3);
    expect(takeoverVerdict(next, takeover({ epoch: 2 }), "Minis")).toMatchObject({
      kind: "refuse",
      check: "lease",
    });
    expect(takeoverVerdict(next, takeover({ epoch: 4 }), "Minis").kind).toBe("proceed");
    const [, lower] = heartbeatContinued(
      next,
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 1 }] },
      later,
    );
    expect(findIncoming(lower, m4, sourceThread)?.lease.epoch).toBe(3);
  });

  it("renews the replica's lease at the same epoch and clears unknown", () => {
    const document = markUnreachable(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      Date.parse(now) + HANDOFF_LEASE_STALE_MS + 1,
    );
    expect(findIncoming(document, m4, sourceThread)?.sourceUnreachable).toBe(true);
    const [, next] = heartbeatContinued(
      document,
      { sourceEnvironmentId: m4, leases: [{ sourceThreadId: sourceThread, epoch: 1 }] },
      later,
    );
    const replica = findIncoming(next, m4, sourceThread);
    expect(replica?.sourceUnreachable).toBe(false);
    expect(replica?.lease.renewedAt).toBe(later);
  });

  it("leaves a recently seen source reachable", () => {
    const document = stored(EMPTY_HANDOFF_DOCUMENT, meta(3));
    expect(markUnreachable(document, Date.parse(now) + HANDOFF_LEASE_STALE_MS)).toBe(document);
  });
});

describe("linked project", () => {
  const project = (id: string, title: string, members: Array<[string, string]>) => ({
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/work/${id}`,
    deletedAt: null,
    workspaceSettings: {
      logicalProject: {
        members: members.map(([environmentId, projectId]) => ({ environmentId, projectId })),
      },
    },
  });

  it("joins only through an explicit link, never by name", () => {
    const sameName = project("p-same", "Fix the build", []);
    const linked = project("p-linked", "Other title", [[m4, sourceProject]]);
    expect(linkedLocalProject([sameName], m4, sourceProject)).toBeNull();
    expect(linkedLocalProject([sameName, linked], m4, sourceProject)?.id).toBe("p-linked");
    expect(linkedLocalProject([linked], minis, sourceProject)).toBeNull();
    expect(linkedLocalProject([{ ...linked, deletedAt: now }], m4, sourceProject)).toBeNull();
  });
});

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Handoff Test",
      "-c",
      "user.email=handoff@example.invalid",
      "-C",
      cwd,
      ...args,
    ],
    { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const claude = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as unknown as ModelSelection;
const codex = { instanceId: "codex", model: "gpt-5.5" } as unknown as ModelSelection;

/**
 * Minis receiving one thread from M4 over a real Git repository, with M4's
 * work grant kept in memory: what it records, revokes and launches.
 */
const receiving = (options: { readonly runtimeMode?: RuntimeMode } = {}) =>
  Effect.gen(function* () {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-incoming-")),
    );
    temporary.push(base);
    const root = NodePath.join(base, "repo");
    NodeFS.mkdirSync(root);
    git(root, "init", "-q", "-b", "feat/x");
    NodeFS.writeFileSync(NodePath.join(root, "app.ts"), "export const a = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    NodeFS.writeFileSync(NodePath.join(root, "app.ts"), "export const a = 2;\n");
    const written = yield* Effect.promise(() =>
      writeCheckpoint({ cwd: root, threadId: sourceThread }),
    );
    let document: Document = EMPTY_HANDOFF_DOCUMENT;
    const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const origins = new Map<string, WorkOrigin>();
    const grantState = { revoked: false };
    const launchState = { fail: false };
    const project = {
      id: localProject,
      title: "App",
      workspaceRoot: root,
      deletedAt: null,
      workspaceSettings: {
        logicalProject: { members: [{ environmentId: m4, projectId: sourceProject }] },
      },
    };
    const provider = (instanceId: string, slug: string) => ({
      instanceId,
      driver: instanceId,
      displayName: instanceId,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug }],
    });
    const services = Layer.mergeAll(
      Layer.succeed(HandoffMode, {
        environmentId: minis,
        machineLabel: "Minis",
        document: Effect.sync(() => document),
        updateDocument: <A>(change: (current: Document) => readonly [A, Document]) =>
          Effect.sync(() => {
            const [result, next] = change(document);
            document = next;
            return result;
          }),
      } as unknown as HandoffMode["Service"]),
      Layer.succeed(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as never),
      Layer.succeed(ServerConfig.ServerConfig, {
        worktreesDir: NodePath.join(base, "worktrees"),
      } as never),
      Layer.succeed(ProjectService.ProjectService, {
        snapshot: Effect.succeed({ projects: [project] }),
      } as never),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([
          provider("claudeAgent", "claude-opus-5-5"),
          provider("codex", "gpt-5.5"),
        ]),
      } as never),
      Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
        launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
          launchState.fail
            ? Effect.fail(new LaunchRefusedError({ message: "the provider refused to start" }))
            : Effect.sync(() => {
                launches.push(input);
                return { threadId: input.threadId, projection: {}, resumed: false };
              }),
      } as never),
      Layer.succeed(Orchestrator.OrchestratorV2, {
        dispatch: () => Effect.succeed({}),
      } as never),
      Layer.succeed(WorkGrants.WorkGrants, {
        ...WorkGrants.WorkGrants.defaultValue(),
        enabled: true,
        forCoordinator: (id: EnvironmentId) =>
          Effect.sync(() => ({ ...unscopedGrant(id), revoked: grantState.revoked })),
        originOf: (thread: { readonly id: ThreadId }) => Effect.sync(() => origins.get(thread.id)),
        recordOrigin: (threadId: ThreadId, origin: WorkOrigin) =>
          Effect.sync(() => {
            origins.set(threadId, origin);
          }),
        forgetOrigin: (threadId: ThreadId) =>
          Effect.sync(() => {
            origins.delete(threadId);
          }),
      }),
    );
    const receiver = yield* HandoffReceiver.make.pipe(Effect.provide(services));
    const replicate = (caller: HandoffReceiver.ReceiverCaller, modelSelection: ModelSelection) =>
      receiver.replicate(
        caller,
        {
          ...meta(1),
          modelSelection,
          runtimeMode: options.runtimeMode ?? "full-access",
          checkpoint: {
            ...checkpoint(1),
            commit: written.commit,
            baseCommit: written.baseCommit,
            branch: written.branch,
            ref: written.ref,
            skipped: [...written.skipped],
          },
        },
        null,
      );
    const preflight = (caller: HandoffReceiver.ReceiverCaller, modelSelection: ModelSelection) =>
      receiver.preflight(caller, {
        sourceEnvironmentId: m4,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: HANDOFF_APP_VERSION,
        threads: [
          {
            sourceThreadId: sourceThread,
            sourceProjectId: sourceProject,
            sequence: 1,
            modelSelection,
          },
        ],
      });
    const takeOver = (caller: HandoffReceiver.ReceiverCaller) =>
      receiver.takeover(caller, takeover({ sequence: 1 }));
    return {
      receiver,
      replicate,
      preflight,
      takeOver,
      launches,
      origins,
      grantState,
      launchState,
      worktreesDir: NodePath.join(base, "worktrees"),
      document: () => document,
    };
  });

const peer = (
  grant: Partial<EffectiveWorkGrant> = {},
  runtimeCeiling: RuntimeMode | null = "full-access",
): HandoffReceiver.ReceiverCaller => ({
  sourceEnvironmentId: m4,
  grant: { ...unscopedGrant(m4), owner: "other", ...grant },
  runtimeCeiling,
});
const self: HandoffReceiver.ReceiverCaller = { sourceEnvironmentId: m4, grant: null };
const onlyClaude = { accounts: { kind: "listed" as const, instanceIds: [claude.instanceId] } };

describe("takeover under the source's work grant", () => {
  it.effect("refuses a sign-in the grant does not allow, in preflight and takeover", () =>
    Effect.gen(function* () {
      const { replicate, preflight, takeOver, launches, origins, worktreesDir, document } =
        yield* receiving();
      const caller = peer(onlyClaude);
      yield* replicate(caller, codex);
      const checked = yield* preflight(caller, codex);
      expect(checked.results[0]?.failures).toEqual([
        {
          check: "grant",
          message:
            "Minis: this machine lets M4 use only these sign-ins: claudeAgent. The user can allow codex in Settings > Connections > Who can run work on this Mac.",
        },
      ]);
      const refused = yield* takeOver(caller).pipe(Effect.flip);
      expect(refused).toMatchObject({ status: 403, code: "needs_grant", check: "grant" });
      expect(refused.message).toContain("only these sign-ins: claudeAgent");
      // Nothing changed here: no worktree, no lease, no origin, no thread.
      expect(NodeFS.existsSync(worktreesDir)).toBe(false);
      expect(Object.keys(document().threads)).toEqual([]);
      expect(origins.size).toBe(0);
      expect(launches).toHaveLength(0);
      // A grant with no sign-ins says so.
      const none = yield* preflight(peer({ accounts: { kind: "none" } }), codex);
      expect(none.results[0]?.failures[0]?.message).toContain("use none of its sign-ins");
    }),
  );

  it.effect("passes a sign-in the grant allows, and every sign-in under all or legacy", () =>
    Effect.gen(function* () {
      const { replicate, preflight } = yield* receiving();
      yield* replicate(peer(), codex);
      expect((yield* preflight(peer(onlyClaude), claude)).results[0]?.failures).toEqual([]);
      expect((yield* preflight(peer(), codex)).results[0]?.failures).toEqual([]);
      expect((yield* preflight(peer({ legacy: true }), codex)).results[0]?.failures).toEqual([]);
    }),
  );

  it.effect("lowers the mode to the credential's ceiling and says so", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches } = yield* receiving();
      const caller = peer({}, "auto-accept-edits");
      yield* replicate(caller, claude);
      const response = yield* takeOver(caller);
      expect(launches[0]?.runtimeMode).toBe("auto-accept-edits");
      expect(launches[0]?.interactionMode).toBe("default");
      expect(response.notice).toBe(
        "Runs at auto-accept-edits here (lowered from full-access) under this Mac's limits for M4.",
      );
    }),
  );

  it.effect("keeps a mode at or below the ceiling, with no notice", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches } = yield* receiving({
        runtimeMode: "approval-required",
      });
      const caller = peer({}, "auto-accept-edits");
      yield* replicate(caller, claude);
      const response = yield* takeOver(caller);
      expect(launches[0]?.runtimeMode).toBe("approval-required");
      expect(response.notice).toBeNull();
    }),
  );

  it.effect("records the continuation as the source's work before it launches", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, origins } = yield* receiving();
      yield* replicate(peer(), claude);
      const response = yield* takeOver(peer());
      expect(launches[0]?.threadId).toBe(response.threadId);
      expect(origins.get(response.threadId)).toEqual({
        coordinatorEnvironmentId: m4,
        path: [m4],
        hops: 1,
      });
    }),
  );

  it.effect("leaves a self continue unrestricted and records no origin", () =>
    Effect.gen(function* () {
      const { replicate, preflight, takeOver, launches, origins } = yield* receiving();
      yield* replicate(self, codex);
      expect((yield* preflight(self, codex)).results[0]?.failures).toEqual([]);
      const response = yield* takeOver(self);
      expect(launches[0]?.runtimeMode).toBe("full-access");
      expect(launches[0]?.modelSelection).toEqual(codex);
      expect(response.notice).toBeNull();
      expect(origins.size).toBe(0);
    }),
  );

  it.effect(
    "drops the origin when the move fails, so a later self continue is not the source's",
    () =>
      Effect.gen(function* () {
        const { replicate, takeOver, launches, origins, launchState } = yield* receiving();
        yield* replicate(peer(), claude);
        launchState.fail = true;
        const refused = yield* takeOver(peer()).pipe(Effect.flip);
        expect(refused).toMatchObject({ status: 500, code: "failed" });
        expect(origins.size).toBe(0);
        // The user continues the same epoch here: the same thread id, under no grant.
        launchState.fail = false;
        const response = yield* takeOver(self);
        expect(launches[0]?.threadId).toBe(response.threadId);
        expect(origins.size).toBe(0);
      }),
  );

  it.effect("clears an origin left on the same id when this machine continues it itself", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, origins } = yield* receiving();
      yield* replicate(self, claude);
      const stale = HandoffReceiver.continuationThreadId(
        m4,
        sourceThread,
        takeover({ sequence: 1 }).epoch,
      );
      origins.set(stale, { coordinatorEnvironmentId: m4, path: [m4], hops: 1 });
      const response = yield* takeOver(self);
      expect(response.threadId).toBe(stale);
      expect(origins.size).toBe(0);
    }),
  );

  it.effect("refuses a takeover whose grant was revoked after the route checked it", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, origins, grantState, document } = yield* receiving();
      // The route resolved the grant before the revoke landed.
      const caller = peer();
      yield* replicate(caller, claude);
      grantState.revoked = true;
      const refused = yield* takeOver(caller).pipe(Effect.flip);
      expect(refused).toMatchObject({ status: 403, code: "needs_grant", check: "grant" });
      expect(refused.message).toBe("Minis: this machine revoked M4's work here");
      expect(launches).toHaveLength(0);
      expect(origins.size).toBe(0);
      expect(Object.keys(document().threads)).toEqual([]);
    }),
  );
});
