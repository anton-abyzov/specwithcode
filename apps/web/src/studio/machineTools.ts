import {
  createEnvironmentGuardedCommand,
  createEnvironmentRpcCommand,
} from "@specweave-studio/client-runtime/state/runtime";
import { runStreamGuarded } from "@specweave-studio/client-runtime/rpc";
import {
  type EnvironmentId,
  MACHINE_TOOLS_RPC_METHODS,
  type MachineToolId,
  type MachineToolInstallEvent,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

/** One install on one machine; the log is the machine's own lines. */
export interface MachineToolInstallState {
  readonly tool: MachineToolId | null;
  readonly status: "idle" | "running" | "done" | "failed";
  readonly lines: ReadonlyArray<string>;
  /** The closing line: what was installed, or why it was not. */
  readonly detail: string | null;
  /** macOS or another installer carries on in its own window. */
  readonly handedOff: boolean;
}

export const IDLE_MACHINE_TOOL_INSTALL: MachineToolInstallState = {
  tool: null,
  status: "idle",
  lines: [],
  detail: null,
  handedOff: false,
};

/** Kept short: a log is for reading what happened, not a full transcript. */
const MAX_LINES = 400;

export function reduceMachineToolEvent(
  state: MachineToolInstallState,
  event: MachineToolInstallEvent,
): MachineToolInstallState {
  if (event.type === "log")
    return { ...state, lines: [...state.lines, event.line].slice(-MAX_LINES) };
  return {
    ...state,
    status: event.ok ? "done" : "failed",
    detail: event.detail,
    handedOff: event.handedOff === true,
  };
}

/** One install per machine at a time; it outlives the row or dialog that started it. */
export const machineToolInstallAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<MachineToolInstallState>(IDLE_MACHINE_TOOL_INSTALL).pipe(Atom.keepAlive),
);

const reason = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The install stopped.";

export const machineTools = {
  check: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-tools:check",
    tag: MACHINE_TOOLS_RPC_METHODS.machineToolsCheck,
  }),
  install: createEnvironmentGuardedCommand(connectionAtomRuntime, {
    label: "machine-tools:install",
    execute: (input: { readonly tool: MachineToolId }, registry, environmentId) => {
      const atom = machineToolInstallAtom(environmentId);
      return Effect.sync(() =>
        registry.set(atom, { ...IDLE_MACHINE_TOOL_INSTALL, tool: input.tool, status: "running" }),
      ).pipe(
        Effect.andThen(
          runStreamGuarded(MACHINE_TOOLS_RPC_METHODS.machineToolsInstall, input).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() =>
                registry.set(atom, reduceMachineToolEvent(registry.get(atom), event)),
              ),
            ),
          ),
        ),
        Effect.andThen(
          Effect.sync(() => {
            const state = registry.get(atom);
            if (state.status === "running")
              registry.set(atom, {
                ...state,
                status: "failed",
                detail: "The machine ended the install without a result.",
              });
          }),
        ),
        Effect.tapCause((cause) =>
          Effect.sync(() =>
            registry.set(atom, {
              ...registry.get(atom),
              status: "failed",
              detail: reason(Cause.squash(cause)),
            }),
          ),
        ),
      );
    },
  }),
};
