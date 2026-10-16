import { test } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import { DEFAULT_SERVER_SETTINGS, type VoiceSettings } from "@specweave-studio/contracts";
import { elevenLabsConfigFromSettings, synthesizeElevenLabsVoice } from "./elevenLabsVoice.ts";
const config = {
  apiKey: "private-test-key",
  voiceId: "selected-voice",
  modelId: "eleven_flash_v2_5",
};
const signal = () => new AbortController().signal;
const reply = (response: Response) => (async () => response) as typeof fetch;
const voice = (patch: Partial<VoiceSettings>): VoiceSettings => ({
  ...DEFAULT_SERVER_SETTINGS.voice,
  ...patch,
});
test("only a complete ElevenLabs choice enables the cloud voice", () => {
  NodeAssert.equal(elevenLabsConfigFromSettings(DEFAULT_SERVER_SETTINGS.voice), null);
  NodeAssert.equal(
    elevenLabsConfigFromSettings(voice({ provider: "local", elevenLabsApiKey: "k" })),
    null,
  );
  NodeAssert.throws(
    () => elevenLabsConfigFromSettings(voice({ provider: "elevenlabs", elevenLabsApiKey: "k" })),
    /API key and voice ID/,
  );
  NodeAssert.throws(
    () =>
      elevenLabsConfigFromSettings(
        voice({ provider: "elevenlabs", elevenLabsApiKey: "k", elevenLabsVoiceId: "../bad" }),
      ),
    /valid ElevenLabs voice ID/,
  );
  NodeAssert.deepEqual(
    elevenLabsConfigFromSettings(
      voice({
        provider: "elevenlabs",
        elevenLabsApiKey: " private-test-key ",
        elevenLabsVoiceId: "selected-voice",
      }),
    ),
    config,
  );
});
test("uses selected voice, neutral pacing, and encoded audio", async () => {
  const audio = await synthesizeElevenLabsVoice("Hello Anton.", config, signal(), (async (
    url,
    options,
  ) => {
    NodeAssert.match(String(url), /\/selected-voice\?output_format=mp3_44100_128$/);
    NodeAssert.equal(options?.redirect, "error");
    NodeAssert.equal(new Headers(options?.headers).get("xi-api-key"), config.apiKey);
    const body = JSON.parse(String(options?.body));
    NodeAssert.equal(body.text, "Hello Anton.");
    NodeAssert.equal(body.model_id, config.modelId);
    NodeAssert.equal(body.voice_settings.speed, 1);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch);
  NodeAssert.deepEqual(audio, new Uint8Array([1, 2, 3]));
});
test("provider failures give safe actionable messages", async () => {
  for (const [status, pattern] of [
    [401, /access was refused/],
    [403, /access was refused/],
    [404, /not found/],
    [429, /usage or request limit/],
    [500, /could not generate/],
  ] as const) {
    await NodeAssert.rejects(
      synthesizeElevenLabsVoice(
        "Hello",
        config,
        signal(),
        reply(new Response("private-test-key", { status })),
      ),
      pattern,
    );
  }
});
test("rejects non-audio and empty audio", async () => {
  await NodeAssert.rejects(
    synthesizeElevenLabsVoice(
      "Hello",
      config,
      signal(),
      reply(new Response("{}", { headers: { "content-type": "application/json" } })),
    ),
    /invalid audio/,
  );
  await NodeAssert.rejects(
    synthesizeElevenLabsVoice(
      "Hello",
      config,
      signal(),
      reply(new Response(new Uint8Array(), { headers: { "content-type": "audio/mpeg" } })),
    ),
    /no audio/,
  );
});
test("hang-up cancels synthesis without leaking fetch errors", async () => {
  const controller = new AbortController();
  const pending = synthesizeElevenLabsVoice("Hello", config, controller.signal, (async (
    _url,
    options,
  ) => {
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("private-test-key")), {
        once: true,
      });
    });
  }) as typeof fetch);
  controller.abort();
  await NodeAssert.rejects(pending, /Voice call ended/);
});
test("bounds streaming audio memory", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(20 * 1024 * 1024 + 1));
      controller.close();
    },
  });
  await NodeAssert.rejects(
    synthesizeElevenLabsVoice(
      "Hello",
      config,
      signal(),
      reply(new Response(stream, { headers: { "content-type": "audio/mpeg" } })),
    ),
    /too large/,
  );
});
