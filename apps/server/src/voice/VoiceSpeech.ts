import { VoiceSpeechError, WS_METHODS, WsVoiceRpcGroup } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { elevenLabsConfigFromSettings, synthesizeElevenLabsVoice } from "./elevenLabsVoice.ts";

const messageOf = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "Could not read the reply aloud.";

/**
 * Speaks one call reply with the ElevenLabs voice in the server's voice
 * settings. The key is read from the secret store here and never leaves the
 * server; a hang-up interrupts the request.
 */
export const synthesizeVoiceReply = (
  text: string,
  request: typeof fetch = fetch,
): Effect.Effect<
  { readonly audio: string },
  VoiceSpeechError,
  ServerSettings.ServerSettingsService
> =>
  Effect.gen(function* () {
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
      // No cause: a settings decode error can quote a hand-edited key.
      Effect.mapError(() => new VoiceSpeechError({ detail: "Could not read voice settings." })),
    );
    const config = yield* Effect.try({
      try: () => elevenLabsConfigFromSettings(settings.voice),
      catch: (cause) => new VoiceSpeechError({ detail: messageOf(cause) }),
    });
    if (config === null) {
      return yield* new VoiceSpeechError({
        detail: "ElevenLabs is not selected in Voice settings.",
      });
    }
    const audio = yield* Effect.tryPromise({
      try: (signal) => synthesizeElevenLabsVoice(text, config, signal, request),
      catch: (cause) => new VoiceSpeechError({ detail: messageOf(cause) }),
    });
    return { audio: Buffer.from(audio).toString("base64") };
  });

/**
 * The `voice.*` handlers, registered apart from the rest of the WebSocket API
 * (see `WsVoiceRpcGroup`).
 */
export const layerRpcHandlers = WsVoiceRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return {
      [WS_METHODS.voiceSynthesize]: ({ text }) =>
        synthesizeVoiceReply(text).pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, settings),
        ),
    };
  }),
);
