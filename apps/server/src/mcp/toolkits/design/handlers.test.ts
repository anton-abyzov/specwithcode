import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DesignGetResult,
  type DesignListResult,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";

import * as DesignService from "../../../design/DesignService.ts";
import {
  HERE,
  layerDesignDependencies,
  makeDesignFixture,
  PROJECT_A,
  PROJECT_B,
  SCRATCH,
  TEST_BROWSER_ENV,
} from "../../../design/DesignService.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { DesignSystemProposals } from "../../../design/systems/DesignSystemService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const threadInA = ThreadId.make("thread-design-a");
const threadInScratch = ThreadId.make("thread-design-scratch");
const projectOf: Record<string, ProjectId> = {
  [threadInA]: PROJECT_A,
  [threadInScratch]: SCRATCH,
};

const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-here"),
  requestNamespace: `design-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "design-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "design-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const call = (threadId: ThreadId, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

/** A declared failure comes back as `isError` with the encoded failure as JSON text. */
const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};
const successOf = <A>(result: McpSchema.CallToolResult) => {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as A;
};

const withServer = <A, E>(
  run: Effect.Effect<A, E, McpServer.McpServer | DesignService.DesignService>,
  executable?: string,
) =>
  Effect.acquireUseRelease(
    Effect.sync(makeDesignFixture),
    (fixture) =>
      run.pipe(
        Effect.provide(
          Layer.mergeAll(McpHttpServer.layerDesignToolkit, DesignService.layerWithRender).pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(DesignSystemProposals.layer),
            Layer.provide(layerDesignDependencies(fixture, executable)),
            Layer.provide(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: (threadId) =>
                  Effect.succeed({
                    ...liveThreadShell(threadId),
                    projectId: projectOf[threadId] ?? PROJECT_A,
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex"),
                      model: "gpt-5",
                    },
                  }),
              }),
            ),
          ),
        ),
      ),
    (fixture) => Effect.sync(fixture.cleanup),
  );

it.effect("registers every design tool on the production MCP server (0973 AC-10)", () =>
  withServer(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      for (const name of [
        "design_list",
        "design_get",
        "design_create",
        "design_apply",
        "design_history",
        "design_save_version",
        "design_restore",
        "design_screenshot",
        "design_system_list",
        "design_system_get",
        "design_system_scan",
        "design_system_propose",
      ]) {
        expect(names).toContain(name);
      }
    }),
  ),
);

it.effect("creates, edits and versions a design bound to the calling thread (AC-09, AC-16)", () =>
  withServer(
    Effect.gen(function* () {
      const created = successOf<DesignGetResult>(
        yield* call(threadInA, "design_create", { kind: "design", title: "Pricing" }),
      );
      expect(created.ref.owner).toMatchObject({ kind: "project", projectId: PROJECT_A });
      expect(created.document.thread).toEqual({ environmentId: HERE, threadId: threadInA });
      expect(created.document.createdBy).toEqual({
        kind: "agent",
        threadId: threadInA,
        provider: "codex",
        model: "gpt-5",
      });
      const unbound = successOf<DesignGetResult>(
        yield* call(threadInA, "design_create", {
          kind: "slides",
          title: "Deck",
          bindThread: false,
        }),
      );
      expect(unbound.document.thread).toBeUndefined();

      const designId = created.document.id;
      const pageId = created.document.pages[0]!.id;
      const applied = successOf<DesignGetResult>(
        yield* call(threadInA, "design_apply", {
          designId,
          expectedRevision: 0,
          operations: [{ op: "set_title", title: "Pricing v2" }],
        }),
      );
      expect(applied.document.revision).toBe(1);
      // A stale revision tells the agent what to re-read.
      const stale = failureOf(
        yield* call(threadInA, "design_apply", {
          designId,
          expectedRevision: 0,
          operations: [{ op: "delete_page", pageId }],
        }),
      );
      expect(stale).toMatchObject({ code: "invalid_request" });
      expect(stale.message).toContain("expectedRevision 1");
      successOf(yield* call(threadInA, "design_save_version", { designId, name: "Review" }));
      const history = successOf<{ entries: Array<{ kind: string }> }>(
        yield* call(threadInA, "design_history", { designId }),
      );
      expect(history.entries.map((entry) => entry.kind)).toEqual([
        "version",
        "revision",
        "revision",
      ]);
      const listed = successOf<DesignListResult>(yield* call(threadInA, "design_list", {}));
      expect(listed.designs).toHaveLength(2);
    }),
  ),
);

it.effect("refuses another project, the Playground, and access changes (AC-07, AC-14)", () =>
  withServer(
    Effect.gen(function* () {
      const designs = yield* DesignService.DesignService;
      const inB = yield* designs.create(DesignService.ownerCaller, {
        owner: { kind: "project", projectId: PROJECT_B },
        kind: "design",
        title: "B",
      });
      const inPlayground = yield* designs.create(DesignService.ownerCaller, {
        owner: { kind: "playground" },
        kind: "design",
        title: "Mine",
      });
      const projectB = { kind: "project", projectId: PROJECT_B };
      for (const [name, args] of [
        ["design_get", { designId: inB.document.id, owner: projectB }],
        ["design_list", { owner: projectB }],
        [
          "design_apply",
          {
            designId: inB.document.id,
            owner: projectB,
            expectedRevision: 0,
            operations: [{ op: "set_title", title: "x" }],
          },
        ],
        ["design_get", { designId: inPlayground.document.id, owner: { kind: "playground" } }],
        ["design_system_list", { owner: { kind: "playground" } }],
      ] as const) {
        expect(failureOf(yield* call(threadInA, name, args)), name).toMatchObject({
          code: "capability_denied",
        });
      }
      // The image tool reports failures as an error whose text starts with the failure code.
      const screenshot = yield* call(threadInA, "design_screenshot", {
        designId: inB.document.id,
        owner: projectB,
      });
      expect(screenshot.isError).toBe(true);
      expect(screenshot.content[0]).toMatchObject({
        type: "text",
        text: "capability_denied: This thread can only use its own project's designs.",
      });
      // A Scratch thread works in the Playground and cannot reach projects.
      expect(
        successOf<DesignGetResult>(
          yield* call(threadInScratch, "design_get", { designId: inPlayground.document.id }),
        ).document.title,
      ).toBe("Mine");
      expect(
        failureOf(
          yield* call(threadInScratch, "design_get", {
            designId: inB.document.id,
            owner: projectB,
          }),
        ),
      ).toMatchObject({ code: "capability_denied" });

      const own = successOf<DesignGetResult>(
        yield* call(threadInA, "design_create", { kind: "design", title: "Gated" }),
      );
      expect(
        failureOf(
          yield* call(threadInA, "design_apply", {
            designId: own.document.id,
            expectedRevision: 0,
            operations: [{ op: "set_access", agents: "edit" }],
          }),
        ),
      ).toMatchObject({ code: "capability_denied" });
      yield* designs.apply(DesignService.ownerCaller, {
        owner: { kind: "project", projectId: PROJECT_A },
        designId: own.document.id,
        expectedRevision: 0,
        operations: [{ op: "set_access", agents: "view" }],
      });
      expect(
        failureOf(
          yield* call(threadInA, "design_apply", {
            designId: own.document.id,
            expectedRevision: 1,
            operations: [{ op: "set_title", title: "Nope" }],
          }),
        ),
      ).toMatchObject({ code: "capability_denied", message: expect.stringContaining("view-only") });
      expect(
        failureOf(
          yield* call(threadInA, "design_restore", {
            designId: own.document.id,
            revision: 0,
            expectedRevision: 1,
          }),
        ),
      ).toMatchObject({ code: "capability_denied" });
    }),
  ),
);

it.effect(
  "tells an agent with an old Playground brief where a moved design went (1046 AC-02)",
  () =>
    withServer(
      Effect.gen(function* () {
        const designs = yield* DesignService.DesignService;
        const created = yield* designs.create(DesignService.ownerCaller, {
          owner: { kind: "playground" },
          kind: "design",
          title: "Connect me",
        });
        yield* designs.move(DesignService.ownerCaller, {
          owner: { kind: "playground" },
          designId: created.document.id,
          to: { kind: "project", projectId: PROJECT_A },
          expectedRevision: 0,
        });
        // The thread moved with it into project A; its brief still names the Playground.
        const failure = failureOf(
          yield* call(threadInA, "design_get", {
            designId: created.document.id,
            owner: { kind: "playground" },
          }),
        );
        expect(failure).toMatchObject({ code: "invalid_request" });
        expect(failure.message).toBe(
          `Moved to Alpha. It keeps its id: retry with owner {"kind":"project","projectId":"${PROJECT_A}"} and designId ${created.document.id}.`,
        );
        const there = successOf<DesignGetResult>(
          yield* call(threadInA, "design_get", {
            designId: created.document.id,
            owner: { kind: "project", projectId: PROJECT_A },
          }),
        );
        expect(there.document.title).toBe("Connect me");
      }),
    ),
);

it.live("returns a design screenshot as an MCP image", (ctx) =>
  Effect.gen(function* () {
    const executable = (yield* HostProcessEnvironment)[TEST_BROWSER_ENV];
    if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
    yield* withServer(
      Effect.gen(function* () {
        const created = successOf<DesignGetResult>(
          yield* call(threadInA, "design_create", { kind: "design", title: "Shot" }),
        );
        const frameId = created.document.pages[0]!.nodes[0]!.id;
        const result = yield* call(threadInA, "design_screenshot", {
          designId: created.document.id,
          frameId,
        });
        expect(result.isError, JSON.stringify(result.content[0])).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          designId: created.document.id,
          revision: 0,
          screenshot: { mimeType: "image/png", width: 1440, height: 1024 },
        });
        const image = result.content.find((block) => block.type === "image");
        expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
        const bytes = Buffer.from((image as { data: Uint8Array }).data);
        expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
        expect(bytes.readUInt32BE(16)).toBe(1440);
      }),
      executable,
    );
  }),
);
