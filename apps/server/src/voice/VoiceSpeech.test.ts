import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import { synthesizeVoiceReply } from "./VoiceSpeech.ts";

const elevenLabs = {
  voice: {
    provider: "elevenlabs" as const,
    elevenLabsVoiceId: "voice-1",
    elevenLabsApiKey: "xi-server-key",
  },
};

it.effect("speaks with the key and voice saved in server settings", () =>
  Effect.gen(function* () {
    let usedKey: string | null = null;
    const result = yield* synthesizeVoiceReply("Hello.", (async (url, options) => {
      NodeAssert.match(String(url), /\/text-to-speech\/voice-1\?/);
      usedKey = new Headers(options?.headers).get("xi-api-key");
      return new Response(new Uint8Array([7, 8]), { headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch);
    NodeAssert.equal(usedKey, "xi-server-key");
    NodeAssert.equal(result.audio, Buffer.from([7, 8]).toString("base64"));
  }).pipe(Effect.provide(ServerSettings.layerTest(elevenLabs))),
);

it.effect("refuses without a cloud request when ElevenLabs is not set up", () =>
  Effect.gen(function* () {
    const never = (async () => {
      throw new Error("no request expected");
    }) as typeof fetch;
    const error = yield* Effect.flip(synthesizeVoiceReply("Hello.", never));
    NodeAssert.match(error.detail, /not selected/);
    const missing = yield* Effect.flip(
      synthesizeVoiceReply("Hello.", never).pipe(
        Effect.provide(
          ServerSettings.layerTest({ voice: { provider: "elevenlabs", elevenLabsVoiceId: "v" } }),
        ),
      ),
    );
    NodeAssert.match(missing.message, /API key and voice ID/);
  }).pipe(Effect.provide(ServerSettings.layerTest())),
);

it.effect("never returns the key or the provider's body in an error", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      synthesizeVoiceReply(
        "Hello.",
        (async () => new Response("xi-server-key rejected", { status: 401 })) as typeof fetch,
      ),
    );
    NodeAssert.match(error.detail, /access was refused/);
    NodeAssert.doesNotMatch(JSON.stringify(error), /xi-server-key/);
  }).pipe(Effect.provide(ServerSettings.layerTest(elevenLabs))),
);
