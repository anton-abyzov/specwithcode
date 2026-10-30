import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectSkillsService from "./ProjectSkillsService.ts";

const cwd = "/nonexistent/project-skills-service-test";
const worktree = "/nonexistent/worktrees/project-skills-service-test/thread-a";
const projectId = ProjectId.make("project-skills");

const shell = (fields: {
  readonly projectId: string;
  readonly worktreePath: string | null;
  readonly deletedAt?: unknown;
}) => ({ deletedAt: null, ...fields });

const provider = (id: string): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(id),
    enabled: true,
    availability: "available",
    status: "ready",
    skills: [],
    workspaceSnapshots: [
      { cwd, skills: [] },
      { cwd: worktree, skills: [] },
    ],
  }) as never;

const threadA = ThreadId.make("thread-a");

const makeLayer = (
  calls: Array<{ instanceId: string; fresh: boolean | undefined; cwd?: string }>,
  reads: Array<string> = [],
) => {
  const providers = [provider("claudeAgent"), provider("codex")];
  const registry = Layer.effect(
    ProviderRegistry.ProviderRegistry,
    Effect.gen(function* () {
      const base = yield* ProviderRegistry.ProviderRegistry;
      return ProviderRegistry.ProviderRegistry.of({
        ...base,
        refreshWorkspaceSnapshot: (input) =>
          Effect.sync(() => {
            calls.push({ instanceId: input.instanceId, fresh: input.fresh, cwd: input.cwd });
            return providers;
          }),
      });
    }),
  ).pipe(Layer.provide(ProviderRegistryMock.layer(providers)));
  return ProjectSkillsService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        registry,
        Layer.succeed(
          ProjectStore.ProjectStoreV2,
          ProjectStore.ProjectStoreV2.of({
            get: () => Effect.succeedSome({ workspaceRoot: cwd }),
          } as never),
        ),
        Layer.succeed(
          ProjectionStore.ProjectionStoreV2,
          ProjectionStore.ProjectionStoreV2.of({
            getThreadSummaries: (summaryProjectId: string, threadIds: ReadonlyArray<string>) =>
              Effect.sync(() => {
                reads.push(`summaries:${threadIds.join(",")}`);
                return summaryProjectId === projectId && threadIds.includes(threadA)
                  ? [{ id: threadA, projectId, title: "A", branch: null, worktreePath: worktree }]
                  : [];
              }),
            getShellSnapshot: (options?: { readonly maxAgeMs?: number }) =>
              Effect.sync(() => {
                reads.push(`snapshot:${options?.maxAgeMs ?? "fresh"}`);
              }).pipe(
                Effect.as({
                  threads: [
                    shell({ projectId, worktreePath: worktree }),
                    shell({ projectId: "other-project", worktreePath: "/nonexistent/other" }),
                    shell({ projectId, worktreePath: "/nonexistent/deleted", deletedAt: "gone" }),
                  ],
                  archivedThreads: [],
                }),
              ),
          } as never),
        ),
        NodeServices.layer,
      ),
    ),
  );
};

it.effect("a plain read keeps snapshots; Rescan asks each provider for a fresh scan", () => {
  const calls: Array<{ instanceId: string; fresh: boolean | undefined; cwd?: string }> = [];
  return Effect.gen(function* () {
    const service = yield* ProjectSkillsService.ProjectSkillsService;

    yield* service.read({ projectId });
    assert.deepStrictEqual(
      calls.map((call) => call.fresh),
      [false, false],
    );

    calls.length = 0;
    const snapshot = yield* service.read({ projectId, refresh: true });
    assert.deepStrictEqual(calls, [
      { instanceId: "claudeAgent", fresh: true, cwd },
      { instanceId: "codex", fresh: true, cwd },
    ]);
    assert.deepStrictEqual(
      snapshot.providers.map((state) => state.state),
      ["ok", "ok"],
    );
  }).pipe(Effect.provide(makeLayer(calls)));
});

it.effect("a thread worktree of the project is read in place of the workspace root", () => {
  const calls: Array<{ instanceId: string; fresh: boolean | undefined; cwd?: string }> = [];
  return Effect.gen(function* () {
    const service = yield* ProjectSkillsService.ProjectSkillsService;

    const snapshot = yield* service.read({ projectId, cwd: `${worktree}/` });
    assert.strictEqual(snapshot.cwd, worktree);
    assert.deepStrictEqual(
      calls.map((call) => call.cwd),
      [worktree, worktree],
    );

    const root = yield* service.read({ projectId, cwd });
    assert.strictEqual(root.cwd, cwd);
  }).pipe(Effect.provide(makeLayer(calls)));
});

it.effect("a folder outside the project's root and worktrees is refused", () => {
  const calls: Array<{ instanceId: string; fresh: boolean | undefined; cwd?: string }> = [];
  return Effect.gen(function* () {
    const service = yield* ProjectSkillsService.ProjectSkillsService;
    for (const folder of [
      "/etc",
      "/nonexistent/other",
      "/nonexistent/deleted",
      `${worktree}/../../../../etc`,
    ]) {
      const error = yield* service.read({ projectId, cwd: folder }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "cwd_not_allowed", folder);
    }
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(makeLayer(calls)));
});

it.effect("a thread's own folder is checked against that thread alone", () => {
  const calls: Array<{ instanceId: string; fresh: boolean | undefined; cwd?: string }> = [];
  const reads: Array<string> = [];
  return Effect.gen(function* () {
    const service = yield* ProjectSkillsService.ProjectSkillsService;

    const snapshot = yield* service.read({ projectId, cwd: worktree, threadId: threadA });
    assert.strictEqual(snapshot.cwd, worktree);
    assert.deepStrictEqual(reads, ["summaries:thread-a"]);

    const other = yield* service
      .read({ projectId, cwd: "/nonexistent/other", threadId: ThreadId.make("thread-b") })
      .pipe(Effect.flip);
    assert.strictEqual(other.reason, "cwd_not_allowed");
    assert.deepStrictEqual(reads, ["summaries:thread-a", "summaries:thread-b"]);
  }).pipe(Effect.provide(makeLayer(calls, reads)));
});

it.effect(
  "a recent answer is reused before any thread lookup; without a thread id the snapshot may be cached",
  () => {
    const calls: Array<{ instanceId: string; fresh: boolean | undefined; cwd?: string }> = [];
    const reads: Array<string> = [];
    return Effect.gen(function* () {
      const service = yield* ProjectSkillsService.ProjectSkillsService;

      yield* service.read({ projectId, cwd: worktree });
      assert.deepStrictEqual(reads, ["snapshot:15000"]);
      assert.strictEqual(calls.length, 2);

      // Reopening the popover within the cache window reads neither the
      // projection store nor the providers.
      const again = yield* service.read({ projectId, cwd: `${worktree}/` });
      assert.strictEqual(again.cwd, worktree);
      assert.deepStrictEqual(reads, ["snapshot:15000"]);
      assert.strictEqual(calls.length, 2);

      // The cached folder belongs to this project only.
      const foreign = ProjectId.make("project-other");
      const refused = yield* service.read({ projectId: foreign, cwd: worktree }).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "cwd_not_allowed");

      // Rescan skips the cache and checks the folder again.
      yield* service.read({ projectId, cwd: worktree, refresh: true });
      assert.deepStrictEqual(reads, ["snapshot:15000", "snapshot:15000", "snapshot:15000"]);
    }).pipe(Effect.provide(makeLayer(calls, reads)));
  },
);

it("allowedSkillsCwd keeps the stored spelling of the folder it matches", () => {
  const resolve = (value: string) => value.replace(/\/+$/, "");
  assert.strictEqual(
    ProjectSkillsService.allowedSkillsCwd(resolve, "/root", [], undefined),
    "/root",
  );
  assert.strictEqual(
    ProjectSkillsService.allowedSkillsCwd(resolve, "/root", ["/wt/a"], "/wt/a//"),
    "/wt/a",
  );
  assert.strictEqual(
    ProjectSkillsService.allowedSkillsCwd(resolve, "/root", ["/wt/a"], "/wt/b"),
    null,
  );
});

it("Claude's on-disk switches override a snapshot taken before them, except plugin skills", () => {
  const source = {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    skills: [
      {
        name: "turned-off",
        path: "/p/.claude/skills/turned-off/SKILL.md",
        enabled: true,
        scope: "project",
      },
      {
        name: "turned-on",
        path: "/h/.claude/skills/turned-on/SKILL.md",
        enabled: false,
        scope: "user",
      },
      { name: "plugin-skill", path: "/h/plugins/cache/x/SKILL.md", enabled: true, scope: "plugin" },
    ],
  };
  const switched = ProjectSkillsService.withClaudeSkillSwitches(
    source,
    new Map([
      ["turned-off", false],
      ["plugin-skill", false],
    ]),
  );
  assert.deepStrictEqual(
    switched.skills.map((skill) => [skill.name, skill.enabled]),
    [
      ["turned-off", false],
      ["turned-on", true],
      ["plugin-skill", true],
    ],
  );
});
