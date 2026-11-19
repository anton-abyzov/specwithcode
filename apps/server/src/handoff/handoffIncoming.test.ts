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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import { overTheWire } from "./handoffMove.test.fixture.ts";
import * as HandoffReceiver from "./HandoffReceiver.ts";
// Read through the namespace, so a case for a rule this release adds fails on its own.
import * as HandoffState from "./handoffState.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  fenceRecord,
  findIncoming,
  HANDOFF_INCOMING_MAX,
  HandoffDocument,
  type HandoffDocument as Document,
  heartbeatContinued,
  incomingKey,
  ambiguousLinkMessage,
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
/** A third machine a continuation here moves on to. */
const third = EnvironmentId.make("env-m1");
const onward = ThreadId.make("handoff:onward-on-m1");
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

  it("decodes a full document the previous release wrote, with no receipts", () => {
    // The document schema is the previous release's but for the receipts, so a document
    // with every kind of entry, its receipts left out, is one that release wrote.
    const continued = markContinued(
      stored(EMPTY_HANDOFF_DOCUMENT, meta(3)),
      takeover(),
      response,
      now,
    );
    const written: Document = {
      ...stored(continued, meta(2, 1, ThreadId.make("thread-waiting"))),
      projectModes: { [localProject]: "on" },
      threads: {
        [sourceThread]: {
          ...emptyThreadRecord(localProject),
          mode: "on",
          lease: {
            holderEnvironmentId: minis,
            holderLabel: "Minis",
            holderThreadId: sourceThread,
            epoch: 4,
            renewedAt: now,
            state: "handing-off",
          },
          pendingTakeover: { destinationEnvironmentId: m4, request: takeover({ reason: "sleep" }) },
          autoFence: { environmentId: m4, machineLabel: "M4", at: now },
          runEpochs: { "run-1": 4 },
        },
      },
      pausedSince: now,
      autoContinuePeers: { [m4]: { minutes: 10, baselineAt: now } },
      awaySession: { trigger: "sleep", targetEnvironmentId: m4 },
    };
    const { continuationReceipts: _receipts, ...previous } = encodeDocument(written) as Record<
      string,
      unknown
    >;
    const decoded = decodeDocument(JSON.parse(JSON.stringify(previous)));
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.getOrThrow(decoded)).toEqual({ ...written, continuationReceipts: {} });
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

describe("a takeover that sleep or silence started (1390 AC-36)", () => {
  const document = stored(EMPTY_HANDOFF_DOCUMENT, meta(3));
  const continuationId = HandoffReceiver.continuationThreadId(m4, sourceThread, 2);

  it("is refused with a definite answer, whichever older machine sends it", () => {
    for (const reason of ["sleep", "auto-takeover"] as const) {
      expect(takeoverVerdict(document, takeover({ reason }), "Minis"), reason).toMatchObject({
        kind: "refuse",
        code: "invalid",
        check: "lease",
      });
    }
    // A start a person or the limit rule made still proceeds.
    for (const reason of ["handoff", "machine-handoff", "continue-here"] as const) {
      expect(takeoverVerdict(document, takeover({ reason }), "Minis").kind, reason).toBe("proceed");
    }
  });

  it("already acted on: the same answer again, never not accepted", () => {
    const request = takeover({ reason: "sleep" });
    const continued = markContinued(document, request, response, now);
    expect(takeoverVerdict(continued, request, "Minis")).toEqual({ kind: "repeat", response });
  });

  it("a saved lease alone never lets it proceed: only its thread answers it", () => {
    // The continuation's lease is saved before its thread launches and before the
    // replica is marked continued. A failed launch or a restart leaves only this record.
    const started: Document = {
      ...document,
      threads: {
        [continuationId]: {
          ...emptyThreadRecord(localProject),
          lease: {
            holderEnvironmentId: minis,
            holderLabel: "Minis",
            holderThreadId: continuationId,
            epoch: 2,
            renewedAt: now,
            state: "active",
          },
        },
      },
    };
    for (const epoch of [2, 5]) {
      expect(takeoverVerdict(started, takeover({ reason: "sleep", epoch }), "Minis")).toMatchObject(
        { kind: "refuse", code: "invalid" },
      );
    }
    // The receiver finds that lease, at the epoch it saved, without being told the epoch.
    const idFor = (epoch: number) => HandoffReceiver.continuationThreadId(m4, sourceThread, epoch);
    expect(HandoffState.preparedContinuations(started, idFor)).toEqual({
      found: [{ threadId: continuationId, epoch: 2 }],
      complete: true,
    });
    expect(
      HandoffState.preparedContinuations(started, (epoch) =>
        HandoffReceiver.continuationThreadId(m4, ThreadId.make("thread-other"), epoch),
      ),
    ).toEqual({ found: [], complete: true });
    // The continuation moved on to a third machine at epoch 3: still found at the epoch it took.
    const record = started.threads[continuationId]!;
    const movedOn: Document = {
      ...started,
      threads: {
        [continuationId]: fenceRecord(
          { ...record, lease: { ...record.lease!, epoch: 3 } },
          { environmentId: third, machineLabel: "M1", threadId: onward, at: later },
          "handoff",
        ),
      },
    };
    expect(HandoffState.preparedContinuations(movedOn, idFor)).toEqual({
      found: [{ threadId: continuationId, epoch: 2 }],
      complete: true,
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

  const linkedId = (found: ReturnType<typeof linkedLocalProject>) =>
    found.kind === "linked" ? found.project.id : found.kind;

  it("joins only through an explicit link, never by name", () => {
    const sameName = project("p-same", "Fix the build", []);
    const linked = project("p-linked", "Other title", [
      [m4, sourceProject],
      [minis, "p-linked"],
    ]);
    expect(linkedId(linkedLocalProject([sameName], minis, m4, sourceProject))).toBe("none");
    expect(linkedId(linkedLocalProject([sameName, linked], minis, m4, sourceProject))).toBe(
      "p-linked",
    );
    expect(linkedId(linkedLocalProject([linked], minis, minis, sourceProject))).toBe("none");
    expect(
      linkedId(linkedLocalProject([{ ...linked, deletedAt: now }], minis, m4, sourceProject)),
    ).toBe("none");
  });

  it("needs the link both ways, as a launch does", () => {
    // Lists the source but not itself here: a stale member list, not a link.
    const oneWay = project("p-one-way", "App", [[m4, sourceProject]]);
    expect(linkedId(linkedLocalProject([oneWay], minis, m4, sourceProject))).toBe("none");
  });

  it("refuses two projects here that both list the source, naming both", () => {
    const first = project("p-first", "App", [
      [m4, sourceProject],
      [minis, "p-first"],
    ]);
    const stale = project("p-stale", "App (old)", [
      [m4, sourceProject],
      [minis, "p-stale"],
    ]);
    const found = linkedLocalProject([first, stale], minis, m4, sourceProject);
    expect(found.kind).toBe("ambiguous");
    const message = ambiguousLinkMessage(found.kind === "ambiguous" ? found.projects : []);
    expect(message).toContain("more than one project here lists this source");
    expect(message).toContain("p-first");
    expect(message).toContain("p-stale");
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
const receiving = (
  options: {
    readonly runtimeMode?: RuntimeMode;
    /** The project's Use worktrees switch; on unless a case turns it off. */
    readonly usesWorktrees?: boolean;
    /** More of the source's uncommitted work, made before the checkpoint is written. */
    readonly beforeCheckpoint?: (root: string) => void;
    /** Changes the project folder after the checkpoint is written. */
    readonly afterCheckpoint?: (root: string) => void;
    /** The project folder is the parent of the repository, as in a folder of several clones. */
    readonly repositoryBelowProject?: boolean;
  } = {},
) =>
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
    options.beforeCheckpoint?.(root);
    const written = yield* Effect.promise(() =>
      writeCheckpoint({ cwd: root, threadId: sourceThread }),
    );
    options.afterCheckpoint?.(root);
    let document: Document = EMPTY_HANDOFF_DOCUMENT;
    const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const origins = new Map<string, WorkOrigin>();
    const grantState = { revoked: false };
    const launchState = {
      fail: false,
      /** The thread is created, then the launch fails: an initial message that did not go. */
      failAfterCreate: false,
      /** Holds a launch inside the takeover until the case lets it go. */
      gate: null as { entered: Deferred.Deferred<void>; resume: Deferred.Deferred<void> } | null,
      /** The thread store cannot be read. */
      shellsUnreadable: false,
    };
    /** Threads the launches created, as the thread store holds them. */
    const created = new Set<string>();
    const project = {
      id: localProject,
      title: "App",
      workspaceRoot: options.repositoryBelowProject === true ? base : root,
      deletedAt: null,
      workspaceSettings: {
        logicalProject: {
          members: [
            { environmentId: m4, projectId: sourceProject },
            { environmentId: minis, projectId: localProject },
          ],
        },
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
        getSettings: Effect.succeed(
          options.usesWorktrees === false
            ? DEFAULT_SERVER_SETTINGS
            : {
                ...DEFAULT_SERVER_SETTINGS,
                projectSettingsOverrides: {
                  [localProject]: { defaultThreadEnvMode: "worktree" as const },
                },
              },
        ),
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
          Effect.gen(function* () {
            const gate = launchState.gate;
            if (gate !== null) {
              yield* Deferred.succeed(gate.entered, undefined);
              yield* Deferred.await(gate.resume);
            }
            if (launchState.fail) {
              return yield* Effect.fail(
                new LaunchRefusedError({ message: "the provider refused to start" }),
              );
            }
            launches.push(input);
            if (input.threadId !== undefined) created.add(input.threadId);
            if (launchState.failAfterCreate) {
              return yield* Effect.fail(
                new LaunchRefusedError({ message: "the first message did not go" }),
              );
            }
            return { threadId: input.threadId, projection: {}, resumed: false };
          }),
      } as never),
      Layer.succeed(Orchestrator.OrchestratorV2, {
        dispatch: () => Effect.succeed({}),
        getThreadShell: (threadId: ThreadId) =>
          launchState.shellsUnreadable
            ? Effect.die("the thread store cannot be read")
            : Effect.succeed(
                created.has(threadId)
                  ? { id: threadId, projectId: localProject, modelSelection: claude }
                  : null,
              ),
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
    const replicate = (
      caller: HandoffReceiver.ReceiverCaller,
      modelSelection: ModelSelection,
      threadId: ThreadId = sourceThread,
    ) =>
      receiver.replicate(
        caller,
        {
          ...meta(1, 1, threadId),
          repositoryPath: options.repositoryBelowProject === true ? "repo" : "",
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
      created,
      root,
      baseCommit: written.baseCommit,
      worktreesDir: NodePath.join(base, "worktrees"),
      document: () => document,
      /** What another part of this machine writes to the same file. */
      change: (next: (current: Document) => Document) => {
        document = next(document);
      },
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
            "Minis: this machine lets M4 use only these sign-ins: claudeAgent. The user can allow codex in Settings > Machines > Who can run work here.",
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
        "Runs at auto-accept-edits here (lowered from full-access) under this machine's limits for M4.",
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

/** A heartbeat from M4, holding the thread at `epoch - 1`, asking about its takeover at `epoch`. */
const asking = (epoch: number) => ({
  sourceEnvironmentId: m4,
  sourceLabel: "M4",
  leases: [{ sourceThreadId: sourceThread, epoch: epoch - 1 }],
  settle: [{ sourceThreadId: sourceThread, epoch }],
});

describe("a start an earlier release began here (1390 AC-36)", () => {
  const continuationId = HandoffReceiver.continuationThreadId(m4, sourceThread, 2);

  it.effect(
    "a failed launch, then the same epoch from sleep or silence: nothing launches, the sender stays paused",
    () =>
      Effect.gen(function* () {
        for (const reason of ["sleep", "auto-takeover"] as const) {
          const { receiver, replicate, takeOver, launches, launchState } = yield* receiving();
          yield* replicate(peer(), claude);
          launchState.fail = true;
          // The lease is saved at epoch 2; the launch fails before any thread exists.
          yield* Effect.result(takeOver(peer()));
          launchState.fail = false;
          const answer = yield* receiver
            .takeover(peer(), takeover({ sequence: 1, reason }))
            .pipe(Effect.flip);
          expect(launches, reason).toHaveLength(0);
          // No thread behind the lease may be one deleted here: no answer, which both of
          // the previous release's branches (first send, re-send) read as in doubt.
          expect(answer, reason).toMatchObject({ status: 503, inDoubt: true });
          expect(overTheWire("Minis", answer), reason).toMatchObject({
            code: "unreachable",
            uncertain: true,
          });
        }
        // With nothing begun here, the definite refusal: nothing runs here to wait for.
        const fresh = yield* receiving();
        yield* fresh.replicate(peer(), claude);
        const refused = yield* fresh.receiver
          .takeover(peer(), takeover({ sequence: 1, reason: "sleep" }))
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ status: 409, code: "invalid" });
        expect(overTheWire("Minis", refused)).toMatchObject({ code: "invalid", uncertain: false });
        expect(fresh.launches).toHaveLength(0);
      }),
  );

  it.effect("continued here at another epoch: no answer, never a refusal", () =>
    Effect.gen(function* () {
      const { receiver, replicate, takeOver } = yield* receiving();
      yield* replicate(peer(), claude);
      const response = yield* takeOver(peer());
      // An earlier release asks for epoch 3 of the thread that continues here at 2.
      const answer = yield* receiver
        .takeover(peer(), takeover({ sequence: 1, reason: "sleep", epoch: 3 }))
        .pipe(Effect.flip);
      expect(answer).toMatchObject({ status: 503, inDoubt: true });
      expect(overTheWire("Minis", answer).uncertain).toBe(true);
      // Its heartbeat then fences it with that thread.
      const beat = yield* receiver.heartbeat(peer(), {
        sourceEnvironmentId: m4,
        sourceLabel: "M4",
        leases: [{ sourceThreadId: sourceThread, epoch: 2 }],
      });
      expect(beat.continued).toEqual([
        { sourceThreadId: sourceThread, epoch: 2, threadId: response.threadId },
      ]);
    }),
  );

  it.effect("no replica and no receipt here: unresolved, never none", () =>
    Effect.gen(function* () {
      // An earlier release may have started it before the replica was evicted.
      const { receiver, launches } = yield* receiving();
      expect(yield* receiver.continuation(m4, sourceThread)).toEqual({ kind: "unresolved" });
      const beat = yield* receiver.heartbeat(peer(), asking(2));
      expect(beat).toMatchObject({ continued: [], notStarted: [] });
      const answer = yield* receiver
        .takeover(peer(), takeover({ sequence: 1, reason: "sleep" }))
        .pipe(Effect.flip);
      expect(answer).toMatchObject({ status: 503, inDoubt: true });
      expect(launches).toHaveLength(0);
    }),
  );

  it.effect("a failed launch, then the same epoch by hand: it launches once and continues", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, launchState, document } = yield* receiving();
      yield* replicate(peer(), claude);
      launchState.fail = true;
      yield* Effect.result(takeOver(peer()));
      launchState.fail = false;
      const response = yield* takeOver(peer());
      expect(response.threadId).toBe(continuationId);
      expect(launches).toHaveLength(1);
      expect(findIncoming(document(), m4, sourceThread)?.continuedThreadId).toBe(continuationId);
    }),
  );

  it.effect(
    "launched but never recorded: the same epoch from sleep gets that thread, with no new launch",
    () =>
      Effect.gen(function* () {
        const { receiver, replicate, takeOver, launches, launchState, document } =
          yield* receiving();
        yield* replicate(peer(), claude);
        // The thread is created, then the takeover stops before it records the continuation.
        launchState.failAfterCreate = true;
        yield* Effect.result(takeOver(peer()));
        launchState.failAfterCreate = false;
        expect(launches).toHaveLength(1);
        expect(findIncoming(document(), m4, sourceThread)?.continuedThreadId).toBeNull();
        const answer = yield* Effect.result(
          receiver.takeover(peer(), takeover({ sequence: 1, reason: "sleep" })),
        );
        expect(launches).toHaveLength(1);
        expect(answer).toMatchObject({
          _tag: "Success",
          success: { threadId: continuationId, projectId: localProject, machineLabel: "Minis" },
        });
        // Recorded now: the source's next heartbeat fences it, whatever it asks.
        const beat = yield* receiver.heartbeat(peer(), {
          sourceEnvironmentId: m4,
          sourceLabel: "M4",
          leases: [{ sourceThreadId: sourceThread, epoch: 1 }],
        });
        expect(beat.continued).toEqual([
          { sourceThreadId: sourceThread, epoch: 2, threadId: continuationId },
        ]);
      }),
  );

  it.effect("a heartbeat asking about a takeover answers from the same evidence", () =>
    Effect.gen(function* () {
      // Nothing began: not started, for exactly what was asked.
      const fresh = yield* receiving();
      yield* fresh.replicate(peer(), claude);
      expect(yield* fresh.receiver.heartbeat(peer(), asking(2))).toMatchObject({
        continued: [],
        notStarted: [{ sourceThreadId: sourceThread, epoch: 2 }],
      });
      // A source that asks nothing hears nothing it would not know what to do with.
      const { settle: _settle, ...plain } = asking(2);
      expect((yield* fresh.receiver.heartbeat(peer(), plain)).notStarted).toBeUndefined();
      // A lease saved for a launch that failed has no thread here, which a thread deleted
      // here would look like too: nothing is answered for it.
      const failed = yield* receiving();
      yield* failed.replicate(peer(), claude);
      failed.launchState.fail = true;
      yield* Effect.result(failed.takeOver(peer()));
      expect(yield* failed.receiver.heartbeat(peer(), asking(2))).toMatchObject({
        continued: [],
        notStarted: [],
      });
      // A thread store it cannot read answers nothing for it: the source keeps its hold.
      failed.launchState.shellsUnreadable = true;
      expect(yield* failed.receiver.heartbeat(peer(), asking(2))).toMatchObject({
        continued: [],
        notStarted: [],
      });
      // Launched and never recorded: its thread answers, it is recorded, nothing launches.
      const launched = yield* receiving();
      yield* launched.replicate(peer(), claude);
      launched.launchState.failAfterCreate = true;
      yield* Effect.result(launched.takeOver(peer()));
      expect(yield* launched.receiver.heartbeat(peer(), asking(2))).toMatchObject({
        continued: [{ sourceThreadId: sourceThread, epoch: 2, threadId: continuationId }],
        notStarted: [],
      });
      expect(findIncoming(launched.document(), m4, sourceThread)?.continuedThreadId).toBe(
        continuationId,
      );
      expect(launched.launches).toHaveLength(1);
    }),
  );

  it.effect("a heartbeat during a takeover waits for it, then reports the thread", () =>
    Effect.gen(function* () {
      const { receiver, replicate, launchState, launches } = yield* receiving();
      yield* replicate(peer(), claude);
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      launchState.gate = { entered, resume };
      const taking = yield* Effect.forkChild(receiver.takeover(peer(), takeover({ sequence: 1 })));
      yield* Deferred.await(entered);
      const beating = yield* Effect.forkChild(receiver.heartbeat(peer(), asking(2)));
      for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow;
      // Between the takeover's receipt and its recording, no answer goes out about it.
      expect(beating.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(resume, undefined);
      const response = yield* Fiber.join(taking);
      const beat = yield* Fiber.join(beating);
      expect(launches).toHaveLength(1);
      expect(beat.continued).toEqual([
        { sourceThreadId: sourceThread, epoch: 2, threadId: response.threadId },
      ]);
      expect(beat.notStarted).toEqual([]);
    }),
  );

  it.effect("tells the status check what continues a thread, and never launches", () =>
    Effect.gen(function* () {
      const fresh = yield* receiving();
      yield* fresh.replicate(peer(), claude);
      expect(yield* fresh.receiver.continuation(m4, sourceThread)).toEqual({ kind: "none" });
      const launched = yield* receiving();
      yield* launched.replicate(peer(), claude);
      launched.launchState.failAfterCreate = true;
      yield* Effect.result(launched.takeOver(peer()));
      expect(yield* launched.receiver.continuation(m4, sourceThread)).toEqual({
        kind: "continued",
        threadId: continuationId,
      });
      // Recorded, so later heartbeats fence the source; asked again, the same answer.
      expect(findIncoming(launched.document(), m4, sourceThread)?.continuedThreadId).toBe(
        continuationId,
      );
      expect(yield* launched.receiver.continuation(m4, sourceThread)).toEqual({
        kind: "continued",
        threadId: continuationId,
      });
      expect(launched.launches).toHaveLength(1);
      // Prepared, and the thread store unreadable: unresolved, never none.
      const failed = yield* receiving();
      yield* failed.replicate(peer(), claude);
      failed.launchState.fail = true;
      yield* Effect.result(failed.takeOver(peer()));
      failed.launchState.shellsUnreadable = true;
      expect(yield* failed.receiver.continuation(m4, sourceThread)).toEqual({
        kind: "unresolved",
      });
      // Readable, it is still no proof: a thread read never sees a deleted thread.
      failed.launchState.shellsUnreadable = false;
      expect(yield* failed.receiver.continuation(m4, sourceThread)).toEqual({
        kind: "unresolved",
      });
      expect(failed.launches).toHaveLength(0);
    }),
  );
});

/**
 * The continuation the cut takeover launched moves on to a third machine at epoch 3,
 * as a handoff from here records it: the lease rises and the copy here is fenced.
 */
const movedOn = (current: Document, continuationId: ThreadId): Document => {
  const record = current.threads[continuationId]!;
  return {
    ...current,
    threads: {
      ...current.threads,
      [continuationId]: fenceRecord(
        { ...record, lease: { ...record.lease!, epoch: 3 } },
        { environmentId: third, machineLabel: "M1", threadId: onward, at: later },
        "handoff",
      ),
    },
  };
};

describe("a continuation that moved on, its replica evicted (1390 AC-36)", () => {
  const continuationId = HandoffReceiver.continuationThreadId(m4, sourceThread, 2);

  /** Launched at epoch 2 and cut before it was recorded, moved on, then evicted by replicas. */
  const evicted = Effect.gen(function* () {
    const setup = yield* receiving();
    yield* setup.replicate(peer(), claude);
    setup.launchState.failAfterCreate = true;
    yield* Effect.result(setup.takeOver(peer()));
    setup.launchState.failAfterCreate = false;
    expect(findIncoming(setup.document(), m4, sourceThread)?.continuedThreadId).toBeNull();
    setup.change((current) => movedOn(current, continuationId));
    // Replicas of other threads fill the cache; one never continued here goes first.
    yield* Effect.forEach(
      Array.from({ length: HANDOFF_INCOMING_MAX }, (_, index) =>
        ThreadId.make(`thread-filler-${index}`),
      ),
      (threadId) => setup.replicate(peer(), claude, threadId),
      { concurrency: 8, discard: true },
    );
    expect(setup.document().incoming).toHaveLength(HANDOFF_INCOMING_MAX);
    expect(findIncoming(setup.document(), m4, sourceThread)).toBeUndefined();
    return setup;
  });

  it.effect(
    "the status check and the heartbeat still name it; nothing is not started",
    () =>
      Effect.gen(function* () {
        const { receiver, launches } = yield* evicted;
        expect(yield* receiver.continuation(m4, sourceThread)).toEqual({
          kind: "continued",
          threadId: continuationId,
        });
        const beat = yield* receiver.heartbeat(peer(), asking(2));
        expect(beat.notStarted).toEqual([]);
        expect(beat.continued).toEqual([
          { sourceThreadId: sourceThread, epoch: 2, threadId: continuationId },
        ]);
        // A source on an earlier release asks nothing; its heartbeat fences it all the same.
        const { settle: _settle, ...plain } = asking(2);
        expect((yield* receiver.heartbeat(peer(), plain)).continued).toEqual([
          { sourceThreadId: sourceThread, epoch: 2, threadId: continuationId },
        ]);
        expect(launches).toHaveLength(1);
      }),
    120_000,
  );

  it.effect(
    "with no receipt, as an earlier release left it: found by its lease, never none",
    () =>
      Effect.gen(function* () {
        const { receiver, change, created } = yield* evicted;
        change((current) => ({ ...current, continuationReceipts: {} }));
        // Its thread is gone here too (deleted): nothing proves it never ran.
        created.delete(continuationId);
        expect(yield* receiver.continuation(m4, sourceThread)).toEqual({ kind: "unresolved" });
        expect((yield* receiver.heartbeat(peer(), asking(2))).notStarted).toEqual([]);
        // With its thread there, its lease names it at the epoch it took.
        created.add(continuationId);
        expect(yield* receiver.continuation(m4, sourceThread)).toEqual({
          kind: "continued",
          threadId: continuationId,
        });
      }),
    120_000,
  );
});

/** The folder as the destination has it: the base commit, nothing uncommitted. */
const discard = (root: string) => {
  git(root, "checkout", "-q", "--", ".");
  git(root, "clean", "-fdq");
};
const read = (root: string, file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");

describe("takeover and the project's Use worktrees switch", () => {
  it.effect("off: the work lands in a clean project folder, on the branch checked out there", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, root, baseCommit, worktreesDir } = yield* receiving({
        usesWorktrees: false,
        afterCheckpoint: discard,
      });
      yield* replicate(peer(), claude);
      const response = yield* takeOver(peer());
      expect(launches[0]?.workspaceStrategy).toEqual({ type: "root" });
      expect(NodeFS.existsSync(worktreesDir)).toBe(false);
      expect(read(root, "app.ts")).toBe("export const a = 2;\n");
      expect(git(root, "rev-parse", "HEAD")).toBe(baseCommit);
      expect(git(root, "status", "--porcelain")).toBe("M app.ts");
      expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
      expect(response.notice).toBe(
        "Use worktrees is off for this project, so the work is in the project folder as uncommitted changes.",
      );
    }),
  );

  it.effect("off: a folder that already holds the work is used as it is", () =>
    Effect.gen(function* () {
      // The source worked in this folder: a move between sign-ins on one machine.
      const { replicate, takeOver, launches, root, worktreesDir } = yield* receiving({
        usesWorktrees: false,
        beforeCheckpoint: (folder) =>
          NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "half done\n"),
      });
      yield* replicate(self, claude);
      const response = yield* takeOver(self);
      expect(launches[0]?.workspaceStrategy).toEqual({ type: "root" });
      expect(NodeFS.existsSync(worktreesDir)).toBe(false);
      expect(read(root, "app.ts")).toBe("export const a = 2;\n");
      expect(read(root, "notes.txt")).toBe("half done\n");
      expect(git(root, "status", "--porcelain")).toBe("M app.ts\n?? notes.txt");
      expect(response.notice).toBe(
        "Use worktrees is off for this project, so the work is in the project folder as uncommitted changes.",
      );
    }),
  );

  it.effect("off: names the branch when the folder is on another one", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, root } = yield* receiving({
        usesWorktrees: false,
        afterCheckpoint: (folder) => {
          discard(folder);
          git(folder, "checkout", "-q", "-b", "main");
        },
      });
      yield* replicate(peer(), claude);
      const response = yield* takeOver(peer());
      expect(launches[0]?.workspaceStrategy).toEqual({ type: "root" });
      expect(git(root, "symbolic-ref", "--short", "HEAD")).toBe("main");
      expect(response.notice).toBe(
        "Use worktrees is off for this project, so the work is in the project folder as uncommitted changes, on main (it was on feat/x).",
      );
    }),
  );

  it.effect("off: a folder with uncommitted changes keeps them, and the work gets a worktree", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, root, worktreesDir } = yield* receiving({
        usesWorktrees: false,
        afterCheckpoint: (folder) => {
          discard(folder);
          NodeFS.writeFileSync(NodePath.join(folder, "app.ts"), "export const mine = true;\n");
        },
      });
      yield* replicate(peer(), claude);
      const response = yield* takeOver(peer());
      const strategy = launches[0]?.workspaceStrategy;
      expect(strategy?.type).toBe("existing_worktree");
      const worktreePath = strategy?.type === "existing_worktree" ? strategy.worktreePath : "";
      expect(worktreePath.startsWith(worktreesDir)).toBe(true);
      expect(read(worktreePath, "app.ts")).toBe("export const a = 2;\n");
      expect(read(root, "app.ts")).toBe("export const mine = true;\n");
      expect(response.notice).toBe(
        `Use worktrees is off for this project, but the project folder has uncommitted changes, so the work is in its own worktree at ${worktreePath}.`,
      );
    }),
  );

  it.effect("off: a folder at another commit is left alone", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, root } = yield* receiving({
        usesWorktrees: false,
        afterCheckpoint: (folder) => {
          discard(folder);
          NodeFS.writeFileSync(NodePath.join(folder, "later.ts"), "export const later = 1;\n");
          git(folder, "add", "-A");
          git(folder, "commit", "-q", "-m", "later");
        },
      });
      yield* replicate(peer(), claude);
      const response = yield* takeOver(peer());
      expect(launches[0]?.workspaceStrategy.type).toBe("existing_worktree");
      expect(read(root, "app.ts")).toBe("export const a = 1;\n");
      expect(git(root, "status", "--porcelain")).toBe("");
      expect(response.notice).toContain(
        "the project folder is at a different commit than the work started from",
      );
    }),
  );

  it.effect("off: an ignored file in the way is never overwritten", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, root } = yield* receiving({
        usesWorktrees: false,
        beforeCheckpoint: (folder) =>
          NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "from the source\n"),
        afterCheckpoint: (folder) => {
          discard(folder);
          // A local-only file where the work adds one: Git reports the folder clean.
          NodeFS.appendFileSync(NodePath.join(folder, ".git", "info", "exclude"), "notes.txt\n");
          NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "mine\n");
        },
      });
      yield* replicate(peer(), claude);
      expect(git(root, "status", "--porcelain")).toBe("");
      const response = yield* takeOver(peer());
      const strategy = launches[0]?.workspaceStrategy;
      expect(strategy?.type).toBe("existing_worktree");
      const worktreePath = strategy?.type === "existing_worktree" ? strategy.worktreePath : "";
      expect(read(worktreePath, "notes.txt")).toBe("from the source\n");
      expect(read(root, "notes.txt")).toBe("mine\n");
      expect(read(root, "app.ts")).toBe("export const a = 1;\n");
      expect(response.notice).toContain("the project folder has files in the way");
    }),
  );

  it.effect("off: a folder in the middle of a merge is left alone", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, root } = yield* receiving({
        usesWorktrees: false,
        afterCheckpoint: (folder) => {
          discard(folder);
          NodeFS.writeFileSync(
            NodePath.join(folder, ".git", "MERGE_HEAD"),
            `${git(folder, "rev-parse", "HEAD")}\n`,
          );
        },
      });
      yield* replicate(peer(), claude);
      const response = yield* takeOver(peer());
      expect(launches[0]?.workspaceStrategy.type).toBe("existing_worktree");
      expect(read(root, "app.ts")).toBe("export const a = 1;\n");
      expect(response.notice).toContain("the project folder is in the middle of a merge or rebase");
    }),
  );

  it.effect("off: work for a repository below the project folder keeps its worktree", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, root } = yield* receiving({
        usesWorktrees: false,
        repositoryBelowProject: true,
        afterCheckpoint: discard,
      });
      yield* replicate(peer(), claude);
      const response = yield* takeOver(peer());
      // A thread in the project folder would not run git in that repository.
      expect(launches[0]?.workspaceStrategy.type).toBe("existing_worktree");
      expect(read(root, "app.ts")).toBe("export const a = 1;\n");
      expect(git(root, "status", "--porcelain")).toBe("");
      expect(response.notice).toContain(
        "the project folder is not the repository this work belongs to",
      );
    }),
  );

  it.effect("off: a retry after the work was thrown away puts it back, not a false success", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, launchState, root } = yield* receiving({
        usesWorktrees: false,
        afterCheckpoint: discard,
      });
      yield* replicate(peer(), claude);
      launchState.fail = true;
      yield* takeOver(peer()).pipe(Effect.flip);
      discard(root);
      launchState.fail = false;
      yield* takeOver(peer());
      expect(launches[0]?.workspaceStrategy).toEqual({ type: "root" });
      expect(read(root, "app.ts")).toBe("export const a = 2;\n");
    }),
  );

  it.effect("off: a retry after a failed start finds the work already in the folder", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, launchState, root, worktreesDir } = yield* receiving({
        usesWorktrees: false,
        afterCheckpoint: discard,
      });
      yield* replicate(peer(), claude);
      launchState.fail = true;
      const refused = yield* takeOver(peer()).pipe(Effect.flip);
      expect(refused).toMatchObject({ status: 500, code: "failed" });
      expect(git(root, "status", "--porcelain")).toBe("M app.ts");
      launchState.fail = false;
      const response = yield* takeOver(peer());
      expect(launches[0]?.workspaceStrategy).toEqual({ type: "root" });
      expect(NodeFS.existsSync(worktreesDir)).toBe(false);
      expect(read(root, "app.ts")).toBe("export const a = 2;\n");
      expect(response.notice).toContain("so the work is in the project folder");
    }),
  );

  it.effect("on: a clean project folder is not touched", () =>
    Effect.gen(function* () {
      const { replicate, takeOver, launches, root } = yield* receiving({
        afterCheckpoint: discard,
      });
      yield* replicate(peer(), claude);
      const response = yield* takeOver(peer());
      expect(launches[0]?.workspaceStrategy.type).toBe("existing_worktree");
      expect(read(root, "app.ts")).toBe("export const a = 1;\n");
      expect(git(root, "status", "--porcelain")).toBe("");
      expect(response.notice).toBeNull();
    }),
  );
});
