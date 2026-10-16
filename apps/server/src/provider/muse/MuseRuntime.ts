import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import type { Session, Turn } from "@muse-code/sdk";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AcpTransportError } from "@specweave-studio/effect-acp/errors";
import type * as Acp from "@specweave-studio/effect-acp/compat";
import type {
  AcpSessionRuntime,
  AcpSessionRuntimeEvent,
  AcpSessionRuntimeStartResult,
} from "../acp/AcpSessionRuntime.ts";
import type { MuseSettings } from "@specweave-studio/contracts";
import { connectMuse, museControl } from "./MuseConnection.ts";
import { museModels, museSubscription } from "./MuseDiscovery.ts";
import { watchMuseRequests } from "./MuseRequests.ts";
import { museItemEvents } from "./MuseItems.ts";

type Runtime = AcpSessionRuntime["Service"];
const failure = (cause: unknown) =>
  new AcpTransportError({
    detail: cause instanceof Error ? cause.message : "Muse Code request failed",
    cause,
  });
const attempt = <T>(run: () => Promise<T>) => Effect.tryPromise({ try: run, catch: failure });
const unsupported = () =>
  Effect.fail(failure(new Error("This operation is not supported by the Muse Code integration.")));

export const makeMuseRuntime = (input: {
  settings: MuseSettings;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  resumeSessionId?: string;
  runtimeMode?: string;
  connect?: typeof connectMuse;
}) =>
  Effect.gen(function* () {
    const fs = yield* Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer);
    const realpath = (path: string) => Effect.runPromise(fs.realPath(path));
    const owned = yield* Effect.acquireRelease(
      attempt(() => (input.connect ?? connectMuse)(input.settings, input.environment, input.cwd)),
      ({ client }) => Effect.promise(() => client.close()),
    );
    const { host, client } = owned;
    const request = (method: string, params: Record<string, unknown>) =>
      museControl(host.connection.request(method, params), () => client.close());
    const command = (method: string, params: Record<string, unknown>) =>
      museControl(host.connection.command(method, params), () => client.close());
    const events = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
    const emit = (event: AcpSessionRuntimeEvent) => Effect.runPromise(Queue.offer(events, event));
    let session: Session | undefined;
    let selectedModel: string | undefined;
    let closing = false;
    let stopRequests: (() => void) | undefined;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closing = true;
        stopRequests?.();
      }),
    );
    void host.exited.then(() => {
      if (!closing)
        void emit({
          _tag: "ConnectionTerminated",
          error: failure(new Error("Muse Code host exited.")),
        });
    });
    let turn: Turn | undefined;
    let started: AcpSessionRuntimeStartResult | undefined;
    let permission: Parameters<Runtime["handleRequestPermission"]>[0] | undefined;
    const noRegistration = () => Effect.void;
    const mode = input.runtimeMode === "full-access" ? "allowAll" : "promptUnmatched";
    const initialized: Acp.InitializeResponse = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    };
    const models = async () => {
      const [catalog, usage] = await Promise.all([
        request("model/list", {}),
        request("usage/read", {}),
      ]);
      return museModels(
        catalog,
        museSubscription(usage),
        Boolean(input.environment.META_API_KEY?.trim()),
      );
    };
    const open = (resumeId?: string) =>
      attempt(async () => {
        if (started && !resumeId) return started;
        session = resumeId
          ? await museControl(
              client.resumeSession({ sessionId: resumeId, excludeItems: true }),
              () => client.close(),
            )
          : await museControl(
              client.startSession({ workspaceRoot: input.cwd, approvalMode: mode }),
              () => client.close(),
            );
        // Restored sessions keep their native policy until explicitly reconciled.
        const identity = await request("session/read", { sessionId: session.sessionId });
        const workspaceRoot = (identity.session as { workspaceRoot?: unknown } | undefined)
          ?.workspaceRoot;
        if (
          typeof workspaceRoot !== "string" ||
          (await realpath(workspaceRoot).catch(() => null)) !== (await realpath(input.cwd))
        )
          throw new Error("Muse session belongs to a different workspace.");
        const policy = await command("session/setApprovalMode", {
          sessionId: session.sessionId,
          mode,
        });
        const effective = policy.effectiveMode as { mode?: string } | undefined;
        if (effective?.mode !== mode)
          throw new Error("Muse Code did not apply the requested approval mode.");
        stopRequests?.();
        stopRequests = await watchMuseRequests({
          session,
          request,
          command,
          permission: () => permission,
          failed: (error) => {
            void client.close();
            void emit({ _tag: "ConnectionTerminated", error: failure(error) });
          },
        });
        const offered = await models();
        const options: Acp.SessionConfigOption[] = [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: offered.find((m) => m.isDefault)?.slug ?? "",
            options: offered.map((m) => ({ value: m.slug, name: m.name })),
          },
        ];
        started = {
          sessionId: session.sessionId,
          initializeResult: initialized,
          sessionSetupResult: { sessionId: session.sessionId, configOptions: options },
          modelConfigId: "model",
        };
        return started;
      });
    const setModel = (model: string) =>
      attempt(async () => {
        if (!session) throw new Error("Muse session is not open");
        const offered = await models();
        if (!offered.some((m) => m.slug === model))
          throw new Error(
            "This Muse model is not available to the signed-in account. Refresh Providers or check the Muse Code plan.",
          );
        await command("session/setModel", {
          sessionId: session.sessionId,
          model: { modelId: model },
        });
        const readback = await request("session/read", { sessionId: session.sessionId });
        if ((readback.session as { modelId?: unknown } | undefined)?.modelId !== model)
          throw new Error("Muse Code did not confirm the selected model.");
        selectedModel = model;
      });
    const runtime: Runtime = {
      initialize: () => Effect.succeed(initialized),
      start: () => open(input.resumeSessionId),
      loadSession: (id) => open(id),
      resumeSession: (id) => open(id),
      forkSession: unsupported,
      handleRequestPermission: (handler) =>
        Effect.sync(() => {
          permission = handler;
        }),
      handleElicitation: noRegistration,
      handleMcpConnect: noRegistration,
      handleMcpMessage: noRegistration,
      handleMcpDisconnect: noRegistration,
      handleMcpNotification: noRegistration,
      handleReadTextFile: noRegistration,
      handleWriteTextFile: noRegistration,
      handleCreateTerminal: noRegistration,
      handleTerminalOutput: noRegistration,
      handleTerminalWaitForExit: noRegistration,
      handleTerminalKill: noRegistration,
      handleTerminalRelease: noRegistration,
      handleSessionUpdate: noRegistration,
      handleElicitationComplete: noRegistration,
      handleUnknownExtRequest: noRegistration,
      handleUnknownExtNotification: noRegistration,
      handleExtRequest: noRegistration,
      handleExtNotification: noRegistration,
      getEvents: () => Stream.fromQueue(events),
      drainEvents: Effect.gen(function* () {
        const acknowledge = yield* Deferred.make<void>();
        yield* Queue.offer(events, { _tag: "EventStreamBarrier", acknowledge });
        yield* Deferred.await(acknowledge);
      }),
      getModeState: Effect.succeed(undefined),
      getConfigOptions: Effect.sync(() => started?.sessionSetupResult.configOptions ?? []),
      prompt: (payload, options) =>
        Effect.gen(function* () {
          if (!session) return yield* unsupported();
          if (turn)
            return yield* Effect.fail(failure(new Error("A Muse turn is already running.")));
          const active = session;
          if (payload.prompt.some((part) => part.type !== "text"))
            return yield* Effect.fail(
              failure(
                new Error(
                  "Muse Code currently accepts text and referenced workspace files in SpecWithCode.",
                ),
              ),
            );
          turn = yield* attempt(() =>
            museControl(
              active.sendUserTurn({
                input: payload.prompt.map((part) => ({
                  type: "text" as const,
                  text: part.type === "text" ? part.text : "",
                })),
                ifBusy: "queue",
              }),
              () => client.close(),
            ),
          );
          if (options?.dispatched) yield* Deferred.succeed(options.dispatched, undefined);
          const current = turn;
          const texts = new Map<string, string>();
          const completed = new Set<string>();
          yield* attempt(async () => {
            const publish = async (item: import("@muse-code/sdk").FoldedItem) => {
              const accumulated = active.fold.items.accumulated(item.itemId);
              const summary = item.summary ? [...item.summary] : [];
              for (const field of active.fold.items.accumulatedFields(item.itemId)) {
                if (/^summary\.\d+$/.test(field)) {
                  const index = Number(field.slice(8));
                  const value = active.fold.items.accumulated(item.itemId, field) ?? "";
                  if (value.length > (summary[index]?.length ?? 0)) summary[index] = value;
                }
              }
              const output = active.fold.items.accumulated(item.itemId, "output") ?? "";
              const base = {
                ...item,
                ...(summary.length ? { summary } : {}),
                ...(output.length > (item.visibleOutput?.length ?? 0)
                  ? { visibleOutput: output }
                  : {}),
              };
              const visible =
                accumulated && accumulated.length > (item.text?.length ?? 0)
                  ? { ...base, text: accumulated }
                  : base;
              for (const event of museItemEvents(visible, texts, completed)) await emit(event);
            };
            await Promise.all([
              (async () => {
                for await (const item of current.items()) await publish(item);
              })(),
              (async () => {
                for await (const delta of current.deltas()) {
                  const item = active.fold.items.get(delta.itemId);
                  if (item) await publish(item);
                }
              })(),
            ]);
          });
          const outcome = yield* attempt(() => current.completed);
          turn = undefined;
          if (outcome.kind !== "completed")
            return yield* Effect.fail(
              failure(new Error("Muse turn ended without a confirmed terminal result.")),
            );
          if (outcome.params.terminal === "failed")
            return yield* Effect.fail(
              failure(
                new Error(
                  outcome.params.error?.message ?? outcome.params.reason ?? "Muse turn failed",
                ),
              ),
            );
          if (
            outcome.params.terminal !== "completed" &&
            outcome.params.terminal !== "cancelled" &&
            outcome.params.terminal !== "interrupted"
          )
            return yield* Effect.fail(failure(new Error("Unrecognized Muse terminal result")));
          return {
            stopReason:
              outcome.params.terminal === "completed"
                ? ("end_turn" as const)
                : ("cancelled" as const),
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              turn = undefined;
            }),
          ),
        ),
      cancel: attempt(async () => {
        if (session && turn)
          await command("turn/cancel", { sessionId: session.sessionId, turnId: turn.turnId });
      }),
      processContainment: "none",
      setModel,
      setSessionModel: (model) => setModel(model).pipe(Effect.as({})),
      setMode: unsupported,
      setConfigOption: (id, value) =>
        attempt(async () => {
          if (!session || id !== "reasoningEffort" || typeof value !== "string")
            throw new Error("Unsupported Muse configuration option");
          const offered = (await models()).find((model) => model.slug === selectedModel);
          const descriptor = offered?.capabilities?.optionDescriptors?.find(
            (option) => option.id === id,
          );
          if (
            descriptor?.type !== "select" ||
            !descriptor.options.some((option) => option.id === value)
          )
            throw new Error("Muse model does not offer this reasoning effort");
          await command("session/setReasoningEffort", {
            sessionId: session.sessionId,
            reasoningEffort: value,
          });
          return { configOptions: started?.sessionSetupResult.configOptions ?? [] };
        }),
      listSessions: unsupported,
      closeSession: unsupported,
      deleteSession: unsupported,
      listProviders: unsupported(),
      setProvider: unsupported,
      disableProvider: unsupported,
      logout: unsupported(),
      request: unsupported,
      notify: unsupported,
    };
    return runtime;
  });
