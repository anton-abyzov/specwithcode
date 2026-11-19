/**
 * The live `SecretsPeer`: the source reaches the copy's destination through its
 * worker grant there (RemoteWorkers), the same link studio_file_transfer uses,
 * and calls that machine's studio_folder_copy_receive. The destination applies
 * its own checks; this side only picks the machine by environment id, never by
 * a name, so two machines with one label cannot be confused.
 */
import {
  FolderCopyError,
  FolderCopyLanCheckAnswer,
  type FolderCopySecretsRoute,
  type OrchestratorMcpFailure,
  type OrchestratorMcpMachineRef,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RemoteWorkers from "../RemoteWorkers.ts";
import { SecretsPeer } from "./sealedSecrets.ts";

const CHECK_TIMEOUT_MS = 15_000;
const KEY_TIMEOUT_MS = 30_000;

const Answer = Schema.Struct({
  sealedSecrets: Schema.optional(Schema.Boolean),
  secretsKey: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
const decodeAnswer = Schema.decodeUnknownEffect(Answer);
const decodeLanAnswer = Schema.decodeUnknownEffect(
  Schema.Struct({
    lan: Schema.optional(FolderCopyLanCheckAnswer.fields.lan),
    lanAccepted: Schema.optional(Schema.Boolean),
  }),
);

type RouteReason = NonNullable<FolderCopySecretsRoute["reason"]>;

/** Why a call to the destination did not give a sealed route. */
export const routeReasonOf = (code: OrchestratorMcpFailure["code"]): RouteReason => {
  switch (code) {
    case "unknown_machine":
      return "not_linked";
    case "machine_unreachable":
      return "unreachable";
    case "machine_not_authorized":
    case "capability_denied":
    case "outside_grant_scope":
      return "not_allowed";
    // An older SpecWithCode there does not know the question, and answers it as a bad request.
    default:
      return "update_needed";
  }
};

const refused = (detail: string) => new FolderCopyError({ code: "refused", detail });

const make = Effect.gen(function* () {
  const remote = yield* RemoteWorkers.RemoteWorkers;

  /** The linked machine with exactly this environment id, or null. */
  const machineOf = (destinationEnvironmentId: string) =>
    remote.resolveMachine(destinationEnvironmentId).pipe(
      Effect.map((target): OrchestratorMcpMachineRef | null =>
        target.kind === "remote" && target.machine.environmentId === destinationEnvironmentId
          ? target.machine
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  const ask = (
    machine: OrchestratorMcpMachineRef,
    args: Record<string, unknown>,
    timeoutMs: number,
  ) =>
    remote
      .proxy({ machine, tool: "studio_folder_copy_receive", arguments: args, timeoutMs })
      .pipe(
        Effect.flatMap((answer) =>
          decodeAnswer(answer).pipe(
            Effect.mapError(
              () =>
                ({ code: "orchestration_error", message: "" }) as Pick<
                  OrchestratorMcpFailure,
                  "code" | "message"
                >,
            ),
          ),
        ),
      );

  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  /** One control call to the copy's destination; any failure means the copy stays on Connect. */
  const control = (destinationEnvironmentId: string, args: Record<string, unknown>) =>
    runPromise(
      Effect.gen(function* () {
        const machine = yield* machineOf(destinationEnvironmentId);
        if (machine === null) return yield* Effect.fail("no_route" as const);
        return yield* remote
          .proxy({
            machine,
            tool: "studio_folder_copy_receive",
            arguments: args,
            timeoutMs: CHECK_TIMEOUT_MS,
          })
          .pipe(
            Effect.flatMap(decodeLanAnswer),
            // The failure carries no part of what was sent.
            Effect.mapError(() => "refused" as const),
          );
      }),
    );

  return SecretsPeer.of({
    lan: {
      check: async (destinationEnvironmentId, lanCheck) => ({
        lan:
          (await control(destinationEnvironmentId, { action: "lanCheck", lanCheck })).lan ?? null,
      }),
      offer: async (destinationEnvironmentId, lanOffer) =>
        (await control(destinationEnvironmentId, { action: "lanOffer", lanOffer })).lanAccepted ===
        true,
    },
    route: (destinationEnvironmentId) =>
      Effect.gen(function* () {
        const machine = yield* machineOf(destinationEnvironmentId);
        if (machine === null)
          return { sealed: false, reason: "not_linked" } satisfies FolderCopySecretsRoute;
        return yield* ask(machine, { action: "secretsCheck" }, CHECK_TIMEOUT_MS).pipe(
          Effect.map((answer): FolderCopySecretsRoute =>
            answer.sealedSecrets === true
              ? { sealed: true }
              : { sealed: false, reason: "update_needed" },
          ),
          Effect.catch((error) =>
            Effect.succeed({
              sealed: false,
              reason: routeReasonOf(error.code),
              ...(error.message ? { detail: error.message.slice(0, 1000) } : {}),
            } satisfies FolderCopySecretsRoute),
          ),
        );
      }),
    receivingKey: ({ destinationEnvironmentId, operationId }) =>
      Effect.gen(function* () {
        const machine = yield* machineOf(destinationEnvironmentId);
        if (machine === null)
          return yield* refused(
            "This machine has no link to the copy's destination, so it cannot send it secrets sealed. Start the copy in SpecWithCode on this machine to include them.",
          );
        const answer = yield* ask(
          machine,
          { action: "secretsKey", operationId },
          KEY_TIMEOUT_MS,
        ).pipe(
          Effect.mapError((error) =>
            refused(
              error.message ||
                `${machine.label} did not give a key for the secret files. Update SpecWithCode there and copy again.`,
            ),
          ),
        );
        if (answer.secretsKey === undefined)
          return yield* refused(
            `${machine.label} did not give a key for the secret files. Update SpecWithCode there and copy again.`,
          );
        return answer.secretsKey;
      }),
  });
});

export const layer = Layer.effect(SecretsPeer, make);
