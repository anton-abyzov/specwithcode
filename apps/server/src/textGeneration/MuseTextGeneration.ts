/**
 * MuseTextGeneration — commit messages, PR content, branch names, and thread
 * titles generated through an ephemeral Muse Code session (`muse serve`).
 * The ask-me permission profile routes every tool approval to this client,
 * which denies them all: background text generation is read-only and no
 * person is present to answer. The account's own auth and models apply.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TextGenerationError, type MuseSettings } from "@specweave-studio/contracts";

import { connectMuse, museControl } from "../provider/muse/MuseConnection.ts";
import { museFullEntitled, museModels } from "../provider/muse/MuseDiscovery.ts";
import { MUSE_ASK_PROFILE } from "../provider/muse/MuseRequests.ts";
import * as TextGenerationOperations from "./TextGenerationOperations.ts";

const MUSE_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeMuseTextGeneration = (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof connectMuse = connectMuse,
) => {
  const runMuseJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection } = request;
    return Effect.gen(function* () {
      const text = yield* Effect.tryPromise({
        try: async (signal) => {
          const { host, client } = await connect(settings, environment, cwd);
          try {
            const abort = () => void client.close();
            signal.addEventListener("abort", abort, { once: true });
            try {
              const [catalog, usage] = await Promise.all([
                host.connection.request("model/list", {}),
                host.connection.request("usage/read", {}),
              ]);
              const apiKey = Boolean(environment.META_API_KEY?.trim());
              const offered = museModels(catalog, museFullEntitled(usage, apiKey), apiKey);
              const model =
                modelSelection.model === "default" || modelSelection.model === ""
                  ? offered.find((entry) => entry.isDefault)?.slug
                  : modelSelection.model;
              if (model === undefined || !offered.some((entry) => entry.slug === model)) {
                throw new TextGenerationError({
                  operation,
                  detail:
                    "This Muse model is not available to the signed-in account. Refresh Providers or check the Muse Code plan.",
                });
              }
              const session = await museControl(
                client.startSession({
                  workspaceRoot: cwd,
                  approvalMode: "promptUnmatched",
                  permissionProfile: MUSE_ASK_PROFILE,
                }),
                () => client.close(),
              );
              // Read-only background work: no tool call is ever approved.
              session.onApproval((approval) => {
                const denied = approval.availableChoices.find(
                  (choice) => choice.decision === "denied",
                );
                const fallback = approval.availableChoices.at(-1);
                return { choiceId: (denied ?? fallback)?.choiceId ?? "deny" };
              });
              await museControl(
                host.connection.command("session/setModel", {
                  sessionId: session.sessionId,
                  model: { modelId: model },
                }),
                () => client.close(),
              );
              const turn = await session.sendUserTurn({
                input: [{ type: "text", text: prompt }],
                ifBusy: "queue",
              });
              let reply = "";
              for await (const item of turn.items()) {
                if (item.kind !== "agentMessage") continue;
                const accumulated = session.fold.items.accumulated(item.itemId);
                const visible =
                  accumulated && accumulated.length > (item.text?.length ?? 0)
                    ? accumulated
                    : (item.text ?? "");
                if (visible.length > 0) reply = visible;
              }
              const outcome = await turn.completed;
              if (outcome.kind !== "completed") {
                throw new TextGenerationError({
                  operation,
                  detail: "Muse turn ended without a confirmed terminal result.",
                });
              }
              if (outcome.params.terminal !== "completed") {
                throw new TextGenerationError({
                  operation,
                  detail:
                    outcome.params.error?.message ??
                    outcome.params.reason ??
                    "Muse Code ended the text generation turn without completing it.",
                });
              }
              return reply.trim();
            } finally {
              signal.removeEventListener("abort", abort);
            }
          } finally {
            await client.close();
          }
        },
        catch: (cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Muse Code text generation failed.",
                cause,
              }),
      });
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail: "Muse Code returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Muse Code", text);
    }).pipe(
      Effect.timeoutOption(MUSE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Muse Code request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Muse Code text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  };

  return TextGenerationOperations.fromRunner("MuseTextGeneration", runMuseJson);
};
