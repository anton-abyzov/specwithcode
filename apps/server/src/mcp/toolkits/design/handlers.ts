import {
  OrchestratorMcpFailure,
  type DesignError,
  type DesignOwnerInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as DesignService from "../../../design/DesignService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Access from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { unavailable } from "../../threadAccess.ts";
import { DesignScreenshotToolkit, DesignToolkit } from "./tools.ts";

/**
 * An agent thread acts on its own project's designs, or the Playground's
 * when it runs in the Scratch project, with the design's `agents` access. A
 * client signed in from outside has no thread: it reads any owner it names.
 */
export const designCaller = Effect.fn("mcp.design.caller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) {
    return { actor: { kind: "user" }, audience: "agents" } satisfies DesignService.DesignCaller;
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const thread = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.mapError(unavailable));
  if (thread === null || thread.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const playground = yield* folders.isScratch(thread.projectId);
  return {
    actor: {
      kind: "agent",
      threadId: thread.id,
      provider: String(thread.modelSelection.instanceId).slice(0, 80),
      model: thread.modelSelection.model.slice(0, 120),
    },
    audience: "agents",
    scope: playground ? { kind: "playground" } : { kind: "project", projectId: thread.projectId },
  } satisfies DesignService.DesignCaller;
});

const ownerOf = (caller: DesignService.DesignCaller, owner: DesignOwnerInput | undefined) =>
  owner !== undefined
    ? Effect.succeed(owner)
    : caller.scope !== undefined
      ? Effect.succeed(caller.scope)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass owner: this MCP client is not running inside a SpecWithCode thread.",
          }),
        );

/** A design failure in words an agent can act on. */
export const designFailure = (error: DesignError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "forbidden"
        ? "capability_denied"
        : error.code === "operation_failed"
          ? "orchestration_error"
          : "invalid_request",
    message:
      error.code === "conflict" && error.currentRevision !== undefined
        ? `${error.detail} The design is now at revision ${error.currentRevision}: call design_get, rebuild your operations on it and apply again with expectedRevision ${error.currentRevision}.`
        : error.code === "not_on_this_machine" && error.member !== undefined
          ? `${error.detail} Project ${error.member.projectId} on machine ${error.member.environmentId} has it.`
          : error.code === "not_found" && error.movedTo !== undefined
            ? `${error.detail} It keeps its id: retry with owner ${JSON.stringify(error.movedTo.owner)} and designId ${error.movedTo.designId}.`
            : error.detail,
  });

/** Runs `use` with the caller and the owner it addresses. */
const withDesigns = <A>(
  owner: DesignOwnerInput | undefined,
  use: (
    designs: DesignService.DesignService["Service"],
    caller: DesignService.DesignCaller,
    owner: DesignOwnerInput,
  ) => Effect.Effect<A, DesignError>,
) =>
  Effect.gen(function* () {
    const caller = yield* designCaller();
    const resolvedOwner = yield* ownerOf(caller, owner);
    const designs = yield* DesignService.DesignService;
    return yield* use(designs, caller, resolvedOwner).pipe(Effect.mapError(designFailure));
  });

export const layer = Access.toLayer(DesignToolkit, {
  design_list: Access.reads((input) =>
    Effect.gen(function* () {
      const caller = yield* designCaller();
      const designs = yield* DesignService.DesignService;
      const owner = input.owner ?? caller.scope;
      return yield* designs
        .list(caller, {
          filter:
            owner === undefined
              ? { kind: "all" }
              : owner.kind === "playground"
                ? { kind: "playground" }
                : { kind: "project", projectId: owner.projectId },
        })
        .pipe(Effect.mapError(designFailure));
    }),
  ),
  design_get: Access.reads((input) =>
    withDesigns(input.owner, (designs, caller, owner) =>
      designs.get(caller, {
        owner,
        designId: input.designId,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
      }),
    ),
  ),
  design_create: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const environmentId = yield* environment.getEnvironmentId;
      return yield* withDesigns(input.owner, (designs, caller, owner) =>
        designs.create(caller, {
          owner,
          kind: input.kind,
          title: input.title,
          ...(input.designSystem === undefined ? {} : { designSystem: input.designSystem }),
          ...(input.bindThread === false || scope.thread === undefined
            ? {}
            : { thread: { environmentId, threadId: scope.thread.threadId } }),
        }),
      );
    }),
  ),
  design_apply: Access.actsAsCaller((input) =>
    withDesigns(input.owner, (designs, caller, owner) =>
      designs.apply(caller, {
        owner,
        designId: input.designId,
        expectedRevision: input.expectedRevision,
        operations: input.operations,
      }),
    ),
  ),
  design_history: Access.reads((input) =>
    withDesigns(input.owner, (designs, caller, owner) =>
      designs.history(caller, { owner, designId: input.designId }),
    ),
  ),
  design_save_version: Access.actsAsCaller((input) =>
    withDesigns(input.owner, (designs, caller, owner) =>
      designs.saveVersion(caller, { owner, designId: input.designId, name: input.name }),
    ),
  ),
  design_restore: Access.actsAsCaller((input) =>
    withDesigns(input.owner, (designs, caller, owner) =>
      designs.restore(caller, {
        owner,
        designId: input.designId,
        revision: input.revision,
        expectedRevision: input.expectedRevision,
      }),
    ),
  ),
  design_system_list: Access.reads((input) =>
    Effect.gen(function* () {
      const caller = yield* designCaller();
      const designs = yield* DesignService.DesignService;
      const owner = input.owner ?? caller.scope;
      return yield* designs
        .systemList(caller, {
          filter:
            owner === undefined
              ? { kind: "all" }
              : owner.kind === "playground"
                ? { kind: "playground" }
                : { kind: "project", projectId: owner.projectId },
        })
        .pipe(Effect.mapError(designFailure));
    }),
  ),
  design_system_get: Access.reads((input) =>
    withDesigns(input.owner, (designs, caller, owner) =>
      designs.systemGet(caller, { owner, systemId: input.systemId }),
    ),
  ),
});

export const layerScreenshot = Access.toLayer(DesignScreenshotToolkit, {
  design_screenshot: Access.reads((input) =>
    withDesigns(input.owner, (designs, caller, owner) =>
      Effect.gen(function* () {
        const { document } = yield* designs.get(caller, { owner, designId: input.designId });
        const pageId = input.pageId ?? document.pages[0]!.id;
        const exported = yield* designs.export(caller, {
          owner,
          designId: input.designId,
          pageId,
          format: "png",
          ...(input.frameId === undefined ? {} : { frameId: input.frameId }),
          ...(input.scale === undefined ? {} : { scale: input.scale }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
        });
        return {
          designId: document.id,
          pageId,
          ...(input.frameId === undefined ? {} : { frameId: input.frameId }),
          revision: document.revision,
          screenshot: {
            mimeType: "image/png" as const,
            data: exported.data,
            width: exported.width,
            height: exported.height,
          },
        };
      }),
    ),
  ),
});
