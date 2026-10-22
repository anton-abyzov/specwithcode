// @effect-diagnostics nodeBuiltinImport:off -- The fixture checkout is laid out with node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, expect, it } from "@effect/vitest";
import {
  DesignError,
  type DesignSystem,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  DesignSystemFiles,
  DesignSystemProposals,
  DesignSystemRoots,
  DesignSystemService,
  layer as layerDesignSystems,
  userCaller,
} from "../../../design/systems/DesignSystemService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { DesignSystemsToolkit } from "./tools.ts";

const checkout = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "design-systems-mcp-"));
afterAll(() => NodeFS.rmSync(checkout, { recursive: true, force: true }));
NodeFS.mkdirSync(NodePath.join(checkout, "src/styles"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(checkout, "src/styles/theme.css"),
  [
    ":root {",
    ...Array.from({ length: 10 }, (_, index) => `  --acme-space-${index}: ${index * 4}px;`),
    "  --acme-ink: #111;",
    "  --acme-canvas: #fff;",
    "}",
    ".dark {",
    "  --acme-ink: #eee;",
    "  --acme-canvas: #111;",
    "}",
    "",
  ].join("\n"),
);

const caller = liveThreadShell(ThreadId.make("design-systems-worker"));
const scope: Context.McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  thread: {
    threadId: caller.id,
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
};

const withWrite = (roots: Pick<typeof DesignSystemRoots.Service, "resolve">) =>
  DesignSystemRoots.of({ ...roots, resolveForWrite: roots.resolve });

const written: DesignSystem[] = [];
const roots = withWrite({
  resolve: (who, owner) =>
    who.scope !== undefined &&
    (owner.kind !== "project" ||
      who.scope.kind !== "project" ||
      owner.projectId !== who.scope.projectId)
      ? Effect.fail(new DesignError({ code: "forbidden", detail: "Not this thread's project." }))
      : Effect.succeed({
          owner:
            owner.kind === "project"
              ? { kind: "project", environmentId: "env" as never, projectId: owner.projectId }
              : { kind: "playground", environmentId: "env" as never },
          designRoot: NodePath.join(checkout, ".specweave/design"),
          projectRoot: checkout,
          refPrefix: ".specweave/design/systems/",
        }),
});
const files = DesignSystemFiles.of({
  listDesignSystems: async () => ({ systems: written, problems: [] }),
  readDesignSystem: async () => {
    throw Object.assign(new Error("missing"), { code: "not_found" });
  },
  writeDesignSystem: async (_root, system) => {
    written.push(system);
    return system;
  },
});

const layerFor = (invocation: Context.McpInvocationScope) =>
  Access.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDesignSystems.pipe(
          Layer.provide(Layer.succeed(DesignSystemRoots, roots)),
          Layer.provide(Layer.succeed(DesignSystemFiles, files)),
          Layer.provide(DesignSystemProposals.layer),
        ),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(caller),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          isScratch: () => Effect.succeed(false),
          namedProjectsRoot: checkout,
        }),
        Layer.succeed(Context.McpInvocationContext, invocation),
      ),
    ),
  );

const call = (
  name: "design_system_scan" | "design_system_propose",
  input: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* DesignSystemsToolkit;
    return yield* toolkit.handle(name, input as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result as unknown),
    );
  });

it.effect("scans the thread's project and leaves a proposal for the user to review", () =>
  Effect.gen(function* () {
    const result = (yield* call("design_system_scan", {})) as {
      scan: { suggestions: Array<{ paths: string[] }> };
      proposal: { id: string; owner: unknown; counts: { added: number } };
      next: string;
    };
    expect(result.scan.suggestions[0]!.paths).toEqual(["src/styles/theme.css"]);
    expect(result.proposal.owner).toEqual({ kind: "project", projectId: caller.projectId });
    expect(result.proposal.counts.added).toBe(12);
    expect(result.next).toContain("Settings > Design systems");

    const described = (yield* call("design_system_propose", {
      name: "Calm",
      modes: ["light", "dark"],
      tokens: [{ name: "--ink", value: { light: "#111", dark: "#eee" } }],
    })) as { proposal: { id: string; origin: string; createdBy: { kind: string } } };
    expect(described.proposal).toMatchObject({ origin: "agent", createdBy: { kind: "agent" } });

    // The user sees both proposals; the agent never writes.
    const service = yield* DesignSystemService;
    const pending = yield* service.proposals(userCaller, { kind: "all" });
    expect(pending.proposals.map((proposal) => proposal.id).sort()).toEqual(
      [result.proposal.id, described.proposal.id].sort(),
    );
    expect(written).toEqual([]);

    expect(
      yield* call("design_system_scan", {
        owner: { kind: "project", projectId: ProjectId.make("someone-else") },
      }),
    ).toMatchObject({ code: "capability_denied" });
    expect(yield* call("design_system_scan", { suggestion: "nope" })).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("refuses an MCP client outside a thread", () =>
  Effect.gen(function* () {
    expect(yield* call("design_system_scan", {})).toMatchObject({
      code: "thread_credential_required",
    });
  }).pipe(Effect.provide(layerFor({ ...scope, thread: undefined }))),
);
