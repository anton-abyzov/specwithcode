// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures for the takeover cases.
/**
 * A review thread keeps its reviewer lock across a handoff (1390 AC-40):
 * what the destination continues it on, what its next fallback may pick, and
 * both directions against the previous release.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  type HandoffCheckpoint,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { providerLimitStep } from "../orchestration-v2/ProviderFallbackWorker.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { provider as fixtureProvider } from "../studio/fixtures.ts";
import { writeCheckpoint } from "./checkpointGit.ts";
import { HandoffMode } from "./HandoffMode.ts";
import * as HandoffReceiver from "./HandoffReceiver.ts";
import { arrivedReview, machineReviewTarget } from "./handoffReviewLock.ts";
import * as Previous from "./handoffReviewLock.previousRelease.test.fixture.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  type HandoffDocument as Document,
  incomingKey,
} from "./handoffState.ts";
import {
  HANDOFF_APP_VERSION,
  HANDOFF_PROTOCOL_VERSION,
  PeerErrorBody,
  ReplicateMeta,
} from "./handoffWire.ts";

const m4 = EnvironmentId.make("env-m4");
const minis = EnvironmentId.make("env-minis");
const sourceProject = ProjectId.make("project-src");
const localProject = ProjectId.make("project-local");
const sourceThread = ThreadId.make("thread-src");
const now = "2026-10-20T14:00:00.000Z";
const nowMs = Date.parse(now);

const claude = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as unknown as ModelSelection;
const codex = { instanceId: "codex", model: "gpt-5.5" } as unknown as ModelSelection;
const high = [{ id: "reasoningEffort", value: "high" }];
/** A review by an OpenAI model of work Claude wrote: its policy pins the model, and it runs at high effort. */
const openaiLock = {
  marker: "routing" as const,
  families: ["openai" as const],
  policy: { model: "gpt-5.5" },
  effort: { model: "gpt-5.5", options: high },
};
const STAYS = "Review stays here: no permitted reviewer on Minis";

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

const signIn = (instanceId: string, slug: string) => ({
  instanceId,
  driver: instanceId === "codexWork" ? "codex" : instanceId,
  displayName: instanceId,
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  models: [{ slug }],
});
const CLAUDE_ONLY = [signIn("claudeAgent", "claude-opus-5-5")];
const BOTH = [signIn("claudeAgent", "claude-opus-5-5"), signIn("codex", "gpt-5.5")];

/** Minis receiving one thread from the M4 over a real Git repository. */
const receiving = (signIns: ReadonlyArray<ReturnType<typeof signIn>>) =>
  Effect.gen(function* () {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-review-lock-")),
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
    const project = {
      id: localProject,
      title: "App",
      workspaceRoot: root,
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
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides: {
            [localProject]: { defaultThreadEnvMode: "worktree" as const },
          },
        }),
      } as never),
      Layer.succeed(ServerConfig.ServerConfig, {
        worktreesDir: NodePath.join(base, "worktrees"),
      } as never),
      Layer.succeed(ProjectService.ProjectService, {
        snapshot: Effect.succeed({ projects: [project] }),
      } as never),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed(signIns),
      } as never),
      Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
        launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
          Effect.sync(() => {
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
          Effect.sync(() => ({ ...unscopedGrant(id), revoked: false })),
        recordOrigin: () => Effect.void,
        forgetOrigin: () => Effect.void,
      }),
    );
    const receiver = yield* HandoffReceiver.make.pipe(Effect.provide(services));
    const checkpoint: HandoffCheckpoint = {
      sequence: 1,
      commit: written.commit,
      baseCommit: written.baseCommit,
      branch: written.branch,
      ref: written.ref,
      createdAt: now,
      reason: "turn-end",
      skipped: [...written.skipped],
      excludedSecretCount: 0,
      transcriptMessageCount: 2,
      note: null,
      pushedToOrigin: false,
      epoch: 1,
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
    };
    /** This version's checkpoint message for the thread, as the M4 sends it. */
    const meta = (
      patch: Partial<ReplicateMeta> & Pick<ReplicateMeta, "title" | "modelSelection">,
    ): ReplicateMeta => ({
      sourceEnvironmentId: m4,
      sourceLabel: "M4",
      sourceProjectId: sourceProject,
      sourceThreadId: sourceThread,
      repositoryPath: "",
      runtimeMode: "full-access",
      interactionMode: "default",
      checkpoint,
      lease: {
        holderEnvironmentId: m4,
        holderLabel: "M4",
        holderThreadId: sourceThread,
        epoch: 1,
        renewedAt: now,
        state: "active",
      },
      transcript: [{ role: "user", text: "Review the fix" }],
      execution: null,
      protocolVersion: HANDOFF_PROTOCOL_VERSION,
      appVersion: HANDOFF_APP_VERSION,
      ...patch,
    });
    const caller = (grant: "peer" | "self"): HandoffReceiver.ReceiverCaller =>
      grant === "self"
        ? { sourceEnvironmentId: m4, grant: null }
        : {
            sourceEnvironmentId: m4,
            grant: { ...unscopedGrant(m4), owner: "other" },
            runtimeCeiling: "full-access",
          };
    const preflight = (requested: ModelSelection | null, as: "peer" | "self" = "peer") =>
      receiver
        .preflight(caller(as), {
          sourceEnvironmentId: m4,
          protocolVersion: HANDOFF_PROTOCOL_VERSION,
          appVersion: HANDOFF_APP_VERSION,
          threads: [
            {
              sourceThreadId: sourceThread,
              sourceProjectId: sourceProject,
              sequence: 1,
              modelSelection: requested,
            },
          ],
        })
        .pipe(Effect.map((answer) => answer.results[0]?.failures ?? []));
    const takeOver = (requested: ModelSelection | null, as: "peer" | "self" = "peer") =>
      receiver.takeover(caller(as), {
        sourceEnvironmentId: m4,
        sourceThreadId: sourceThread,
        epoch: 2,
        sequence: 1,
        reason: "handoff",
        modelSelection: requested,
      });
    return {
      receiver,
      checkpoint,
      meta,
      caller,
      preflight,
      takeOver,
      launches,
      document: () => document,
    };
  });

/** A checkpoint message as it crosses the wire: encoded by one schema, read by another. */
const overTheWire = <A>(
  from: { readonly encode: (value: never) => unknown },
  value: unknown,
  to: (raw: unknown) => A,
): A => to(JSON.parse(JSON.stringify(from.encode(value as never))));
const thisVersion = {
  encode: Schema.encodeSync(ReplicateMeta) as (value: never) => unknown,
  decode: Schema.decodeUnknownSync(ReplicateMeta),
};
const previousRelease = {
  encode: Schema.encodeSync(Previous.ReplicateMeta) as (value: never) => unknown,
  decode: Schema.decodeUnknownSync(Previous.ReplicateMeta),
};

// Decoders are built out here: a test body is an Effect generator.
const previousFailure = Schema.decodeUnknownSync(Previous.HandoffPreflightFailure);
const previousErrorBody = Schema.decodeUnknownSync(Previous.PeerErrorBody);
const currentErrorBody = Schema.decodeUnknownSync(PeerErrorBody);

describe("a review thread arriving with its reviewer lock", () => {
  it.effect("a machine holding only the author's family is refused: the review stays", () =>
    Effect.gen(function* () {
      const minisHas = yield* receiving(CLAUDE_ONLY);
      yield* minisHas.receiver.replicate(
        minisHas.caller("peer"),
        minisHas.meta({ title: "Review the fix", modelSelection: codex, reviewLock: openaiLock }),
        null,
      );
      // The source asked for Claude, the family that wrote the work.
      expect(yield* minisHas.preflight(claude)).toEqual([{ check: "provider", message: STAYS }]);
      // Asked for nothing, its own model is missing here too: still that one sentence.
      expect(yield* minisHas.preflight(null)).toEqual([{ check: "provider", message: STAYS }]);
      const refused = yield* minisHas.takeOver(claude).pipe(Effect.flip);
      expect(refused).toMatchObject({ status: 409, code: "invalid", check: "provider" });
      expect(refused.message).toBe(STAYS);
      expect(minisHas.launches).toHaveLength(0);
      expect(Object.keys(minisHas.document().threads)).toEqual([]);
    }),
  );

  it.effect(
    "a machine with a permitted reviewer continues on it, with the marker, the pinned model and the effort",
    () =>
      Effect.gen(function* () {
        const minisHas = yield* receiving(BOTH);
        yield* minisHas.receiver.replicate(
          minisHas.caller("peer"),
          minisHas.meta({ title: "Review the fix", modelSelection: codex, reviewLock: openaiLock }),
          null,
        );
        // The lock is kept beside the copy, as it was sent.
        expect(
          minisHas.document().incomingDetails?.[incomingKey(m4, sourceThread)]?.reviewLock,
        ).toEqual(openaiLock);
        expect(yield* minisHas.preflight(claude)).toEqual([]);
        const answer = yield* minisHas.takeOver(claude);
        const reviewer = { instanceId: "codex", model: "gpt-5.5", options: high };
        expect(answer.modelSelection).toEqual(reviewer);
        expect(answer.notice).toContain("A review keeps to OpenAI models");
        expect(minisHas.launches).toHaveLength(1);
        expect(minisHas.launches[0]?.modelSelection).toEqual(reviewer);
        expect(minisHas.launches[0]?.routing).toMatchObject({
          taskClass: "review",
          reviewFamily: "openai",
          reviewModel: "gpt-5.5",
          selection: reviewer,
        });
      }),
  );

  it.effect("the source's own pick is kept when the lock permits it", () =>
    Effect.gen(function* () {
      const minisHas = yield* receiving(BOTH);
      yield* minisHas.receiver.replicate(
        minisHas.caller("peer"),
        minisHas.meta({ title: "Review the fix", modelSelection: codex, reviewLock: openaiLock }),
        null,
      );
      const answer = yield* minisHas.takeOver(codex);
      expect(answer.modelSelection).toEqual({ ...codex, options: high });
      expect(answer.notice ?? "").not.toContain("A review keeps to");
      expect(minisHas.launches[0]?.routing).toMatchObject({ reviewFamily: "openai" });
    }),
  );

  it.effect("a thread that is no review arrives with no lock and no marker", () =>
    Effect.gen(function* () {
      const minisHas = yield* receiving(BOTH);
      yield* minisHas.receiver.replicate(
        minisHas.caller("peer"),
        minisHas.meta({ title: "Fix the build", modelSelection: codex, reviewLock: null }),
        null,
      );
      const answer = yield* minisHas.takeOver(claude);
      expect(answer.modelSelection).toEqual(claude);
      expect(minisHas.launches[0]?.modelSelection).toEqual(claude);
      expect(minisHas.launches[0]?.routing).toBeUndefined();
    }),
  );

  it.effect("continuing on this machine with another model keeps the lock too", () =>
    Effect.gen(function* () {
      const minisHas = yield* receiving(BOTH);
      yield* minisHas.receiver.replicate(
        minisHas.caller("self"),
        minisHas.meta({ title: "Review the fix", modelSelection: codex, reviewLock: openaiLock }),
        null,
      );
      const answer = yield* minisHas.takeOver(claude, "self");
      expect(answer.modelSelection).toMatchObject({ instanceId: "codex", model: "gpt-5.5" });
      expect(minisHas.launches[0]?.routing).toMatchObject({ reviewFamily: "openai" });
    }),
  );
});

describe("the next fallback on the machine that took a review", () => {
  const claudeId = ProviderInstanceId.make("claudeAgent");
  const codexId = ProviderInstanceId.make("codex");
  const workId = ProviderInstanceId.make("codexWork");
  const used = (base: ServerProvider, slug: string, usedPercent: number): ServerProvider => ({
    ...base,
    models: [{ slug, name: slug, isCustom: false, isDefault: true, capabilities: null }],
    usageLimits: {
      ...base.usageLimits!,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: "2026-10-20T18:00:00.000Z",
        },
      ],
    },
  });
  const claudeFree = used(fixtureProvider(claudeId, "claudeAgent", nowMs), "claude-opus-5-5", 10);
  const codexSpent = used(fixtureProvider(codexId, "codex", nowMs), "gpt-5.5", 100);
  const workFree = used(fixtureProvider(workId, "codex", nowMs), "gpt-5.5", 20);
  // The machine's own rule tries Claude first, then the second OpenAI sign-in.
  const rule = {
    providerLimitAction: "switch" as const,
    providerLimitFallbackModelSelection: { instanceId: claudeId, model: "claude-opus-5-5" },
    providerLimitFallbackModels: [
      { instanceId: claudeId, model: "claude-opus-5-5" },
      { instanceId: workId, model: "gpt-5.5" },
    ],
    providerLimitSwitchAtPercent: 90,
    defaultModelSelection: { instanceId: claudeId, model: "claude-opus-5-5" },
  };

  it.effect(
    "stays inside the lock: the review moves to the second OpenAI sign-in with its effort, never to Claude",
    () =>
      Effect.gen(function* () {
        const minisHas = yield* receiving([
          signIn("claudeAgent", "claude-opus-5-5"),
          signIn("codex", "gpt-5.5"),
          signIn("codexWork", "gpt-5.5"),
        ]);
        yield* minisHas.receiver.replicate(
          minisHas.caller("peer"),
          minisHas.meta({ title: "Review the fix", modelSelection: codex, reviewLock: openaiLock }),
          null,
        );
        yield* minisHas.takeOver(claude);
        const launched = minisHas.launches[0]!;
        // The thread exactly as this machine started it, now stopped on Codex's limit.
        const stopped = {
          id: launched.threadId,
          providerInstanceId: launched.modelSelection.instanceId,
          modelSelection: launched.modelSelection,
          routing: launched.routing,
          status: "failed" as const,
          lastErrorClass: "usage_limit" as const,
          latestRunId: RunId.make("r1"),
          activeRunId: null,
          pendingRuntimeRequest: null,
          settledOverride: null,
        };
        const options = { resetAttempted: true };
        const second = providerLimitStep(
          stopped as never,
          [claudeFree, codexSpent, workFree],
          rule as never,
          nowMs,
          options,
        );
        expect(second).toMatchObject({
          type: "switch",
          command: {
            modelSelection: { instanceId: workId, model: "gpt-5.5", options: high },
          },
        });
        // With Claude as the only sign-in that has room, the review waits.
        expect(
          providerLimitStep(
            stopped as never,
            [claudeFree, codexSpent],
            rule as never,
            nowMs,
            options,
          ),
        ).toBeNull();
        // The same stop without the marker would have gone to Claude.
        expect(
          providerLimitStep(
            { ...stopped, routing: undefined } as never,
            [claudeFree, codexSpent, workFree],
            rule as never,
            nowMs,
            options,
          ),
        ).toMatchObject({ command: { modelSelection: { instanceId: claudeId } } });
      }),
  );
});

describe(`against the previous release (${Previous.PREVIOUS_RELEASE})`, () => {
  const shell = (title: string, modelSelection: ModelSelection) => ({
    id: sourceThread,
    projectId: sourceProject,
    title,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  });

  it("that release does not say it keeps a reviewer lock", () => {
    expect(Previous.PREVIOUS_RELEASE).toBe("v1.0.381");
    const said = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)(
      Previous.descriptor("env-minis", "Minis"),
    );
    expect(said.capabilities.teamRulesCarried).toBe(true);
    expect(said.capabilities.handoffReviewLock).toBeUndefined();
    expect(Previous.peerRules(said)).toEqual({ carried: true });
  });

  it.effect("this version sends, that release receives: an ordinary thread still moves", () =>
    Effect.gen(function* () {
      const minisHas = yield* receiving(BOTH);
      const sent = minisHas.meta({
        title: "Fix the build",
        modelSelection: codex,
        reviewLock: null,
      });
      // That release reads the message and ignores the field it does not know.
      const read = overTheWire(thisVersion, sent, previousRelease.decode);
      expect(read.title).toBe("Fix the build");
      expect("reviewLock" in Previous.incomingDetail(read)).toBe(false);
      expect(
        Previous.takeoverLaunch(
          { modelSelection: claude },
          Previous.incomingDetail(read),
          read.title,
        ).modelSelection,
      ).toEqual(claude);
    }),
  );

  it.effect(
    "this version sends, that release receives: a lock would be dropped there, so a review is never sent",
    () =>
      Effect.gen(function* () {
        const minisHas = yield* receiving(BOTH);
        const sent = minisHas.meta({
          title: "Review the fix",
          modelSelection: codex,
          reviewLock: openaiLock,
        });
        // What that release would do with it: continue on Claude, the author's family.
        const read = overTheWire(thisVersion, sent, previousRelease.decode);
        const there = Previous.takeoverLaunch(
          { modelSelection: claude },
          Previous.incomingDetail(read),
          read.title,
        );
        expect(there.modelSelection).toEqual(claude);
        expect("routing" in there).toBe(false);
        // So the sender's gates decide (handoffPeers.test.ts, MachineLimitHandoff.test.ts).
        expect(sent.reviewLock).not.toBeNull();
      }),
  );

  it.effect("that release sends, this version receives: an ordinary thread still moves", () =>
    Effect.gen(function* () {
      const minisHas = yield* receiving(BOTH);
      const sent = Previous.outgoingMeta({
        self: m4,
        selfLabel: "M4",
        shell: shell("Fix the build", codex),
        repositoryPath: "",
        checkpoint: minisHas.checkpoint,
        lease: null,
        transcript: [{ role: "user", text: "Fix the build" }],
        execution: null,
      });
      const read = overTheWire(previousRelease, sent, thisVersion.decode);
      expect(read.reviewLock).toBeUndefined();
      yield* minisHas.receiver.replicate(minisHas.caller("peer"), read, null);
      expect(yield* minisHas.preflight(claude)).toEqual([]);
      const answer = yield* minisHas.takeOver(claude);
      expect(answer.modelSelection).toEqual(claude);
      expect(minisHas.launches[0]?.routing).toBeUndefined();
    }),
  );

  it.effect(
    "that release sends an Adversarial review thread: this version locks it by its title and model",
    () =>
      Effect.gen(function* () {
        const sent = (checkpoint: HandoffCheckpoint) =>
          overTheWire(
            previousRelease,
            Previous.outgoingMeta({
              self: m4,
              selfLabel: "M4",
              shell: shell("Adversarial review: Fix the build", codex),
              repositoryPath: "",
              checkpoint,
              lease: null,
              transcript: [{ role: "user", text: "Review the fix" }],
              execution: null,
            }),
            thisVersion.decode,
          );
        // A permitted reviewer here: it continues on it, and its fallback is locked from now on.
        const minisHas = yield* receiving(BOTH);
        yield* minisHas.receiver.replicate(
          minisHas.caller("peer"),
          sent(minisHas.checkpoint),
          null,
        );
        const answer = yield* minisHas.takeOver(claude);
        expect(answer.modelSelection).toEqual(codex);
        expect(minisHas.launches[0]?.routing).toMatchObject({ reviewFamily: "openai" });
        // Only the author's family here: refused, in words and codes that release reads.
        const onlyClaude = yield* receiving(CLAUDE_ONLY);
        yield* onlyClaude.receiver.replicate(
          onlyClaude.caller("peer"),
          sent(onlyClaude.checkpoint),
          null,
        );
        const failures = yield* onlyClaude.preflight(claude);
        expect(failures).toEqual([{ check: "provider", message: STAYS }]);
        expect(previousFailure(failures[0])).toEqual(failures[0]);
        const refused = yield* onlyClaude.takeOver(claude).pipe(Effect.flip);
        const body = { error: refused.message, code: refused.code, check: refused.check };
        expect(previousErrorBody(body)).toEqual({
          error: STAYS,
          code: "invalid",
          check: "provider",
        });
        expect(currentErrorBody(body)).toEqual(body);
        expect(onlyClaude.launches).toHaveLength(0);
      }),
  );
});

describe("picking a reviewer inside the lock", () => {
  const lock = { marker: "routing", families: ["openai"], policy: {} } as const;
  const row = (providerInstanceId: string) => ({
    providerInstanceId,
    driverKind: "codex",
    models: ["gpt-5.5"],
    available: true,
  });
  const pickOn = (usable?: (instanceId: string) => boolean) =>
    machineReviewTarget({
      lock,
      target: { environmentId: minis, modelSelection: claude },
      machine: {
        label: "Minis",
        handoffReviewLock: true,
        providers: [row("codex"), row("codexWork")] as never,
      },
      machineLabel: "Minis",
      allowed: () => true,
      ...(usable === undefined
        ? {}
        : { usable: (target) => usable(target.modelSelection.instanceId) }),
    });

  it("asks a machine for the permitted reviewer it would take now, not the first one listed", () => {
    expect(pickOn((instanceId) => instanceId === "codexWork")).toMatchObject({
      kind: "target",
      proven: true,
      target: { modelSelection: { instanceId: "codexWork", model: "gpt-5.5" } },
    });
  });

  it("keeps the first permitted reviewer when none is usable, so its verdict says why", () => {
    expect(pickOn(() => false)).toMatchObject({
      kind: "target",
      target: { modelSelection: { instanceId: "codex", model: "gpt-5.5" } },
    });
  });

  it("refuses with the one sentence when the thread's own model is missing there too", () => {
    expect(
      arrivedReview({
        carried: lock,
        title: "Adversarial review: 1390",
        stored: codex,
        requested: null,
        providers: CLAUDE_ONLY as unknown as ReadonlyArray<ServerProvider>,
        allowed: () => true,
        machineLabel: "Minis",
        sourceLabel: "M4",
        now,
      }),
    ).toEqual({ kind: "refused", message: STAYS });
  });
});
