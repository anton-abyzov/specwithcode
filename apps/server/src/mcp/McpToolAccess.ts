import {
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { Tool } from "effect/ai";
import type { Toolkit } from "effect/ai";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./OrchestratorMcpService.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  unavailable,
} from "./threadAccess.ts";
import { assertThreadChangeable, workGrantOf } from "./workGrantAccess.ts";

// Only the classes below assign these, from their static blocks, so nothing
// outside this module can build a declaration or a handlers layer.

/**
 * Both constructors demand this. Their private constructors only stop the type
 * checker; this also stops `Reflect.construct` and friends at runtime.
 */
const builtHere: unique symbol = Symbol("studio/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

/** Builds a declaration; only the declaration functions below call it. */
let declare: <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

/** Turns each declaration back into the handler it checks, keeping its type. */
interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

/** Only `toLayer` below builds one. */
let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/**
 * Who may call a Studio MCP tool. Every handler is built by one of the
 * declarations below, which say what the tool does. `toLayer` accepts only
 * declarations, and `/mcp` registers only layers `toLayer` built, so a tool
 * without a decision here does not compile. Both are nominal classes, so a
 * handler or layer cannot pass for one by copying its fields. Effect's own
 * registration functions accept any handler, so the
 * `studio/no-raw-mcp-registration` lint rule keeps Effect's `McpServer` inside
 * McpHttpServer.
 *
 * Parameters choose the target; the caller sets the limits: a thread caller
 * its own runtime and interaction modes, an outside client the ceiling it was
 * approved with. Nothing a caller starts or changes may run with broader
 * modes, and a thread caller changes things only while its own run is live.
 * A refusal is an `OrchestratorMcpFailure`, so the compiler requires it in the
 * tool's failure schema, and `ThreadManagementService` in its dependencies.
 *
 * The declaration checks the caller before the handler runs. Handlers still
 * check what only they can see, such as a queued run belonging to its thread.
 */
export class Declaration<out Handler> {
  // A private field makes the class nominal, and only this module can build
  // one: its constructor is private and the static block hands the only way
  // in to module-scoped functions. Copying a declaration's fields onto
  // anything else fails to typecheck and, at runtime, to run.
  readonly #handle: Handler;
  private constructor(token: typeof builtHere, handle: Handler) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
  }
  static {
    declare = (handle) => new Declaration(builtHere, handle);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
  }
}

/** A client approved for read-only access changes nothing. */
export const refuseReadOnlyClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.client?.access === "read-only"
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This tool changes the environment, and this MCP client was approved for read-only access.",
          }),
        )
      : Effect.void,
  ),
);

/**
 * The caller of a tool that changes something. Tools that act for a
 * capability of their own (preview, device, worktree, pull requests) check it
 * themselves.
 */
const writingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(loadCaller()),
  Effect.tap(assertLiveCaller),
);

/** The same, for tools whose only capability is controlling threads. */
const orchestratingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(readCaller()),
  Effect.tap(assertLiveCaller),
);

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

/** Changes nothing, so every caller may call it. */
export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => handle(params));

/** Reads what belongs to the calling Studio thread, such as its preview tabs or devices. */
export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Acts as the calling Studio thread (its subagents, preview tabs, devices,
 * worktree) while that thread's run is live. Only an agent running inside a
 * Studio thread has one.
 */
export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap(() => writingCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

/**
 * Asks a stronger model to review the calling thread (the `advisor` tool).
 * It runs no failing check here: the handler answers a caller that may not
 * consult (no live turn, a read-only client, an advisor thread) with a
 * refusal result, and starts the read-only advisor child itself.
 */
export const consults = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => handle(params));

/** Changes something that belongs to no thread, such as a pending upload or a scheduled task. */
export const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => orchestratingCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Changes the threads `threads` names. An omitted id is the caller's own
 * thread; any other thread must run within the caller's modes, checked here
 * and again by the orchestrator when it applies each command. A thread that
 * does not exist is the handler's to report.
 */
export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const caller = yield* writingCaller;
      // Another machine's work changes only threads its grant covers and its
      // own coordinator owns, the caller's own thread included: a revoked
      // grant stops that too.
      const underGrant = (yield* workGrantOf(caller)) !== undefined;
      for (const threadId of threads(params)) {
        const own = threadId === undefined || threadId === caller.scope.thread?.threadId;
        if (own && !underGrant) continue;
        const target =
          threadId === undefined || own
            ? caller.caller
            : yield* caller.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
        if (target === undefined || target === null || target.deletedAt !== null) continue;
        if (underGrant) yield* assertThreadChangeable(caller, target);
        if (!own) yield* assertTargetWithinLimits(caller.limits, target);
      }
      // The target's user can raise its modes after the check above; the
      // orchestrator checks again under the thread's lock and records its
      // refusal here, since handlers wrap dispatch errors their own way.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      return yield* handle(params).pipe(
        Effect.provideService(DispatchModeLimit, { ...caller.limits, refused }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail<E | OrchestratorMcpFailure>(
              refusal === undefined ? error : escalationDenied(refusal),
            ),
          ),
        ),
      );
    }),
  );

/** How an agent hears that a thread it targets was raised above its modes mid-call. */
const escalationDenied = (refusal: DispatchModeRefusal) =>
  new OrchestratorMcpFailure({
    code:
      refusal.mode === "runtime"
        ? "runtime_mode_escalation_denied"
        : "interaction_mode_escalation_denied",
    message: `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this caller's. Its user changed it while this call ran.`,
  });

/** The modes a started thread runs with: those requested, else the caller's own. */
export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** Starts threads with the modes `modes` requests, which may not be broader than the caller's. */
export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const { limits } = yield* writingCaller;
      const requested = modes(params);
      const started: StartedModes = {
        runtimeMode: yield* resolveRuntimeMode(limits.runtimeMode, requested.runtimeMode),
        interactionMode: yield* resolveInteractionMode(
          limits.interactionMode,
          requested.interactionMode,
        ),
      };
      return yield* handle(params, started);
    }),
  );

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

/**
 * Changes projects or environment settings, which needs a full-access/default
 * caller. `check` re-checks the caller wherever the handler waits before
 * writing, such as for a lock, since the caller's modes can change meanwhile.
 */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
  );
  return declare((params: P) => check.pipe(Effect.flatMap(() => handle(params, check))));
};

/** What a declaration's own check needs. */
type CheckServices = Effect.Services<typeof orchestratingCaller>;

/**
 * Each handler of `Handlers`, built by one of the declarations above. A
 * declaration is never callable, which rules out a handler function wearing a
 * declaration's fields.
 */
type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

/** Anything but a function. */
type NotCallable = { readonly call?: never } & { readonly apply?: never };

/** A toolkit's handlers, each built by one of the declarations above. */
export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

/**
 * A toolkit's handler layer built by `toLayer`, the only kind `/mcp`
 * registers. Like a declaration it is nominal, so nothing else passes for one.
 */
export class HandlersLayer<Tools extends Record<string, Tool.Any>, EX = never, RX = never> {
  readonly #layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>;
  private constructor(
    token: typeof builtHere,
    layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
  ) {
    refuseOutsideConstruction(token);
    this.#layer = layer;
  }
  static {
    handlersLayer = (layer) => new HandlersLayer(builtHere, layer);
  }
  /** The handlers, for registering this toolkit on the MCP server. */
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Struct.map(declarations, checkedHandler);

export const ADVISOR_CALLER_REFUSAL =
  "This thread is an advisor: it may only call SpecWithCode tools that read, and this one changes something or starts work.";

const advisorCallerUnknown = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "SpecWithCode could not confirm that the calling thread is not an advisor, so this tool was refused. Retry in a moment.",
});

/**
 * An advisor child only reads, whatever its provider's sandbox allows: every
 * tool not annotated read-only refuses it. A caller outside a thread passes.
 * Services are read optionally, since a tool may yield only what its
 * dependencies list; `threadsAtBuild` is the thread service the handlers
 * layer was built with, for a tool that does not list it. Anything that
 * keeps the check from reading the caller's thread refuses (fails closed).
 */
export const refuseAdvisorCaller = (
  threadsAtBuild: Option.Option<
    ThreadManagement.ThreadManagementService["Service"]
  > = Option.none(),
): Effect.Effect<void, OrchestratorMcpFailure> =>
  Effect.gen(function* () {
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    if (Option.isNone(scope)) return yield* advisorCallerUnknown;
    const caller = scope.value.thread;
    if (caller === undefined) return;
    const threads = Option.orElse(
      yield* Effect.serviceOption(ThreadManagement.ThreadManagementService),
      () => threadsAtBuild,
    );
    if (Option.isNone(threads)) return yield* advisorCallerUnknown;
    // The same refusal the access checks give for a caller thread they cannot read.
    const shell = yield* threads.value
      .getThreadShell(caller.threadId)
      .pipe(Effect.mapError(unavailable));
    if (shell?.purpose === "advisor")
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: ADVISOR_CALLER_REFUSAL,
      });
  });

type AnyToolHandler = (
  ...args: ReadonlyArray<unknown>
) => Effect.Effect<unknown, OrchestratorMcpFailure, never>;

/** Whether a toolkit's tool is annotated read-only; an unknown name is not. */
export const isReadOnlyTool = (toolkit: Toolkit.Toolkit<any>, name: string): boolean => {
  const tool = (toolkit.tools as Record<string, Tool.Any | undefined>)[name];
  return tool !== undefined && Context.get(tool.annotations, Tool.Readonly) === true;
};

/** Puts `refuseAdvisorCaller` in front of every tool of `toolkit` that is not read-only. */
const guardAdvisorCallers = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Toolkit.HandlersFrom<Tools>,
  threadsAtBuild: Option.Option<ThreadManagement.ThreadManagementService["Service"]>,
): Toolkit.HandlersFrom<Tools> =>
  Object.fromEntries(
    Object.entries(handlers as unknown as Record<string, AnyToolHandler>).map(([name, handler]) => [
      name,
      isReadOnlyTool(toolkit, name)
        ? handler
        : (...args: ReadonlyArray<unknown>) =>
            Effect.andThen(
              refuseAdvisorCaller(threadsAtBuild),
              Effect.suspend(() => handler(...args)),
            ),
    ]),
  ) as unknown as Toolkit.HandlersFrom<Tools>;

/** `Toolkit.toLayer` for handlers that all declare their access. */
export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> => {
  const checked = Effect.isEffect(build)
    ? undefined
    : checkedHandlers<Toolkit.HandlersFrom<Tools>>(build);
  return handlersLayer(
    toolkit.toLayer(
      // Plain declarations are checked now, so a forged one fails where it is passed.
      Effect.gen(function* () {
        const threads = yield* Effect.serviceOption(ThreadManagement.ThreadManagementService);
        const handlers = Effect.isEffect(build)
          ? checkedHandlers<Toolkit.HandlersFrom<Tools>>(yield* build)
          : checked!;
        return guardAdvisorCallers(toolkit, handlers, threads);
      }),
    ),
  );
};

export const COORDINATOR_HANDS_ON_REFUSAL =
  "The coordinator delegates this; start or message a worker with delegate_task or studio_thread_send.";

/**
 * Refuses when the calling thread is its project's coordinator. A caller
 * outside a thread, or one whose thread or project cannot be read, passes:
 * this narrows what a coordinator does, it does not grant anything.
 */
const refuseCoordinatorCaller = (projects: ProjectService.ProjectService["Service"]) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (scope.thread === undefined) return;
    const threadId = scope.thread.threadId;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return;
    const project = yield* projects.getById(shell.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project?.workspaceSettings?.coordinatorThreadId !== threadId) return;
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: COORDINATOR_HANDS_ON_REFUSAL,
    });
  });

/**
 * `toLayer` for hands-on toolkits (preview, preview controls, Chrome,
 * computer, device) that only workers use: every tool first refuses a
 * project's coordinator, which delegates such work instead of doing it.
 * Each tool's failure schema already carries `OrchestratorMcpFailure` and its
 * dependencies `ThreadManagementService`, which every declaration requires.
 */
export const toWorkerLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX | ProjectService.ProjectService, Scope.Scope>> =>
  handlersLayer(
    toolkit.toLayer(
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const declarations = Effect.isEffect(build) ? yield* build : build;
        const handlers = guardAdvisorCallers(
          toolkit,
          checkedHandlers<Toolkit.HandlersFrom<Tools>>(declarations),
          yield* Effect.serviceOption(ThreadManagement.ThreadManagementService),
        );
        const guard = refuseCoordinatorCaller(projects);
        type AnyHandler = (
          params: unknown,
        ) => Effect.Effect<unknown, OrchestratorMcpFailure, never>;
        const guarded = Object.fromEntries(
          Object.entries(handlers as unknown as Record<string, AnyHandler>).map(
            ([name, handler]) => [
              name,
              (params: unknown) => Effect.andThen(guard, handler(params)),
            ],
          ),
        );
        return guarded as unknown as Toolkit.HandlersFrom<Tools>;
      }),
    ),
  );
