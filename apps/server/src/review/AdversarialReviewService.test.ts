import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type { ThreadLaunchInput } from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadIncrementProgressService from "../project/ThreadIncrementProgressService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AdversarialReviewService from "./AdversarialReviewService.ts";

const now = Date.parse("2026-11-04T08:00:00.000Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));
const projectId = ProjectId.make("project-review");
const sourceId = ThreadId.make("thread:source");
const reviewId = ThreadId.make("thread:review");
const worktreePath = "/repo/.worktrees/feat-login";

function provider(
  id: string,
  driver: string,
  displayName: string,
  models: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: fresh,
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 20,
          resetsAt: "2026-11-06T00:00:00.000Z",
        },
      ],
    },
    ...over,
  } as ServerProvider;
}

const claude = provider("claudeAgent", "claudeAgent", "Claude", [
  { slug: "claude-opus-5-5", name: "Opus 5.5" },
  { slug: "claude-fable-5-1", name: "Fable 5.1" },
]);
const codex = provider("codex", "codex", "Codex", [
  { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { slug: "gpt-6-astra", name: "GPT-6 Astra" },
]);
const copilotClaude = provider("copilot", "acpRegistry", "GitHub Copilot", [
  { slug: "claude-opus-5.5", name: "Claude Opus 5.5" },
]);

const sourceThread = {
  id: sourceId,
  projectId,
  title: "Sign in with passkeys",
  providerInstanceId: claude.instanceId,
  modelSelection: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
  runtimeMode: "auto-accept-edits",
  interactionMode: "plan",
  branch: "feat/login",
  worktreePath,
  linkedPullRequest: {
    projectId,
    repository: "acme/app",
    number: 42,
    url: "https://github.com/acme/app/pull/42",
  },
};

const services = (
  providers: ReadonlyArray<ServerProvider>,
  launches: Array<ThreadLaunchInput>,
  thread: Partial<typeof sourceThread>,
) =>
  Layer.mergeAll(
    Layer.succeed(ThreadManagementService.ThreadManagementService, {
      getThreadRecords: (threadId: ThreadId) =>
        Effect.succeed({ thread: { ...sourceThread, ...thread, id: threadId } }),
    } as never),
    Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
      launch: (input: ThreadLaunchInput) =>
        Effect.sync(() => {
          launches.push(input);
          return { threadId: reviewId, projection: {} as never, resumed: false };
        }),
    } as never),
    Layer.succeed(ThreadIncrementProgressService.ThreadIncrementProgressService, {
      read: () =>
        Effect.succeed({
          projectId,
          threads: [
            {
              threadId: sourceId,
              incrementId: "0042-passkeys",
              specPath: "/repo/.specweave/increments/0042-passkeys/spec.md",
            },
          ],
        }),
    } as never),
    Layer.succeed(ProjectService.ProjectService, {
      getById: (id: ProjectId) =>
        Effect.succeed(
          id === projectId
            ? Option.some({ id: projectId, title: "App", workspaceRoot: "/repo" })
            : Option.none(),
        ),
    } as never),
    Layer.succeed(ProviderRegistry.ProviderRegistry, {
      getProviders: Effect.succeed(providers),
    } as never),
    Layer.succeed(ServerSettings.ServerSettingsService, {
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    } as never),
  );

const start = (
  providers: ReadonlyArray<ServerProvider>,
  input: Partial<AdversarialReviewService.AdversarialReviewStartInput> = {},
  thread: Partial<typeof sourceThread> = {},
) => {
  const launches: Array<ThreadLaunchInput> = [];
  return Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const service = yield* AdversarialReviewService.AdversarialReviewService;
    const result = yield* service.start({
      threadId: sourceId,
      commandId: CommandId.make("review-1"),
      trigger: "manual",
      ...input,
    });
    return { result, launches };
  }).pipe(
    Effect.provide(
      AdversarialReviewService.layer.pipe(Layer.provide(services(providers, launches, thread))),
    ),
  );
};

describe("AdversarialReviewService", () => {
  it.effect("reviews a Claude thread on Codex, on the source worktree, with the prompt", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start([claude, codex, copilotClaude]);
      expect(result).toEqual({
        status: "started",
        threadId: reviewId,
        reviewer: { instanceId: codex.instanceId, model: "gpt-6.1-sol" },
        skipped: [],
      });
      expect(launches).toHaveLength(1);
      const launch = launches[0]!;
      expect(launch.title).toBe("Adversarial review: Sign in with passkeys");
      expect(launch.modelSelection).toEqual({ instanceId: codex.instanceId, model: "gpt-6.1-sol" });
      expect(launch.workspaceStrategy).toEqual({
        type: "existing_worktree",
        worktreePath,
        branch: "feat/login",
      });
      expect(launch.runtimeMode).toBe("auto-accept-edits");
      expect(launch.interactionMode).toBe("default");
      expect(launch.launchFallbackFrom).toBeNull();
      expect(launch.increment).toBeUndefined();
      expect(launch.createdBy).toBe("user");
      expect(launch.creationSource).toBe("web");
      const text = launch.initialMessage?.text ?? "";
      expect(text).toContain("Adversarial review.");
      expect(text).toContain("Claude · Opus 5.5");
      expect(text).toContain("0042-passkeys");
      expect(text).toContain("https://github.com/acme/app/pull/42");
      expect(AdversarialReviewService.isAdversarialReviewThread({ title: launch.title })).toBe(
        true,
      );
    }),
  );

  it.effect("refuses a reviewer the person picked from the author's family", () =>
    Effect.gen(function* () {
      const picked = { instanceId: copilotClaude.instanceId, model: "claude-opus-5.5" };
      const { result, launches } = yield* start([claude, codex, copilotClaude], {
        reviewer: picked,
      });
      expect(result).toEqual({
        status: "no-reviewer",
        skipped: [{ selection: picked, reason: "same-family" }],
      });
      expect(launches).toHaveLength(0);
    }),
  );

  it.effect("starts nothing and says why when no other family can review", () =>
    Effect.gen(function* () {
      const signedOutCodex = provider(
        "codex",
        "codex",
        "Codex",
        [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
        { auth: { status: "unauthenticated" } },
      );
      const { result, launches } = yield* start([claude, signedOutCodex, copilotClaude]);
      expect(result.status).toBe("no-reviewer");
      expect(result.skipped.length).toBeGreaterThan(0);
      expect(result.skipped.some((skip) => skip.selection.instanceId === "codex")).toBe(true);
      expect(launches).toHaveLength(0);
    }),
  );

  it.effect("starts an automatic review as the server", () =>
    Effect.gen(function* () {
      const { launches } = yield* start([claude, codex], { trigger: "feature-complete" });
      expect(launches[0]?.createdBy).toBe("system");
      expect(launches[0]?.creationSource).toBe("server");
    }),
  );

  it.effect("reviews work in the project root without switching its branch", () =>
    Effect.gen(function* () {
      const { launches } = yield* start([claude, codex], {}, { worktreePath: null as never });
      expect(launches[0]?.workspaceStrategy).toEqual({ type: "root" });
      const text = launches[0]?.initialMessage?.text ?? "";
      expect(text).toContain("git diff origin/main...feat/login");
      expect(text).toContain("Do not check out the branch");
    }),
  );
});
