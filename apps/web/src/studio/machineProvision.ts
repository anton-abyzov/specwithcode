import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "@specweave-studio/client-runtime/state/runtime";
import { runStreamGuarded } from "@specweave-studio/client-runtime/rpc";
import { type EnvironmentId, PROVISION_RPC_METHODS } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  failProvisionRun,
  IDLE_PROVISION_RUN,
  type ProvisionRunState,
  reduceProvisionEvent,
  startProvisionRun,
} from "./provisionRunState";

/** One run per machine; it outlives the sheet, so closing it never hides a running install. */
export const provisionRunAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<ProvisionRunState>(IDLE_PROVISION_RUN).pipe(Atom.keepAlive),
);

const reason = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "Provisioning stopped.";

export const machineProvision = {
  preview: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-provision:preview",
    tag: PROVISION_RPC_METHODS.provisionPreview,
  }),
  run: createEnvironmentCommand(connectionAtomRuntime, {
    label: "machine-provision:run",
    execute: (input: { readonly resume: boolean }, registry, environmentId) => {
      const atom = provisionRunAtom(environmentId);
      const consume = (resume: boolean) =>
        runStreamGuarded(PROVISION_RPC_METHODS.provisionRun, { resume }).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => registry.set(atom, reduceProvisionEvent(registry.get(atom), event))),
          ),
        );
      return Effect.sync(() => registry.set(atom, startProvisionRun(registry.get(atom)))).pipe(
        Effect.andThen(
          consume(input.resume).pipe(
            // Retry continues the unfinished run; when there is none (it finished, waiting
            // only for root), a fresh run re-checks everything and skips what is done.
            Effect.catchIf(
              (error) =>
                input.resume &&
                error._tag === "ProvisionError" &&
                error.code === "no-run-to-resume",
              () => consume(false),
            ),
          ),
        ),
        Effect.andThen(
          Effect.sync(() => {
            const state = registry.get(atom);
            if (state.status === "running")
              registry.set(
                atom,
                failProvisionRun(state, "The machine ended the run without a result."),
              );
          }),
        ),
        Effect.tapCause((cause) =>
          Effect.sync(() =>
            registry.set(atom, failProvisionRun(registry.get(atom), reason(Cause.squash(cause)))),
          ),
        ),
      );
    },
  }),
};
