import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readElevenLabsVoiceConfig, synthesizeElevenLabsVoice } from "./elevenLabsVoice.ts";
const config = {
  apiKey: "private-test-key",
  voiceId: "selected-voice",
  modelId: "eleven_flash_v2_5",
};
const signal = () => new AbortController().signal;
const reply = (response: Response) => (async () => response) as typeof fetch;
test("only complete explicit Studio configuration enables cloud voice", () => {
  assert.equal(readElevenLabsVoiceConfig({ ELEVENLABS_API_KEY: "unrelated" }), null);
  assert.throws(
    () => readElevenLabsVoiceConfig({ STUDIO_ELEVENLABS_API_KEY: "secret" }),
    /Set both/,
  );
  assert.throws(
    () =>
      readElevenLabsVoiceConfig({
        STUDIO_ELEVENLABS_API_KEY: "secret",
        STUDIO_ELEVENLABS_VOICE_ID: "../bad",
      }),
    /Invalid/,
  );
  assert.deepEqual(
    readElevenLabsVoiceConfig({
      STUDIO_ELEVENLABS_API_KEY: " private-test-key ",
      STUDIO_ELEVENLABS_VOICE_ID: "selected-voice",
    }),
    config,
  );
});
test("uses selected voice, neutral pacing, and encoded audio", async () => {
  const audio = await synthesizeElevenLabsVoice("Hello Anton.", config, signal(), (async (
    url,
    options,
  ) => {
    assert.match(String(url), /\/selected-voice\?output_format=mp3_44100_128$/);
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("xi-api-key"), config.apiKey);
    const body = JSON.parse(String(options?.body));
    assert.equal(body.text, "Hello Anton.");
    assert.equal(body.model_id, config.modelId);
    assert.equal(body.voice_settings.speed, 1);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch);
  assert.deepEqual(audio, new Uint8Array([1, 2, 3]));
});
test("provider failures give safe actionable messages", async () => {
  for (const [status, pattern] of [
    [401, /access was refused/],
    [403, /access was refused/],
    [404, /not found/],
    [429, /usage or request limit/],
    [500, /could not generate/],
  ] as const) {
    await assert.rejects(
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
  await assert.rejects(
    synthesizeElevenLabsVoice(
      "Hello",
      config,
      signal(),
      reply(new Response("{}", { headers: { "content-type": "application/json" } })),
    ),
    /invalid audio/,
  );
  await assert.rejects(
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
  await assert.rejects(pending, /Voice call ended/);
});
test("bounds streaming audio memory", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(20 * 1024 * 1024 + 1));
      controller.close();
    },
  });
  await assert.rejects(
    synthesizeElevenLabsVoice(
      "Hello",
      config,
      signal(),
      reply(new Response(stream, { headers: { "content-type": "audio/mpeg" } })),
    ),
    /too large/,
  );
});
