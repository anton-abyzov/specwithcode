import type { VoiceSettings } from "@specweave-studio/contracts";

export interface ElevenLabsVoiceConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

/**
 * The cloud voice for a call, or `null` for the free on-device voice. Throws a
 * user-facing message when ElevenLabs is chosen but not fully set up.
 */
export function elevenLabsConfigFromSettings(voice: VoiceSettings): ElevenLabsVoiceConfig | null {
  if (voice.provider !== "elevenlabs") return null;
  const apiKey = voice.elevenLabsApiKey.trim();
  const voiceId = voice.elevenLabsVoiceId.trim();
  if (!apiKey || !voiceId) {
    throw new Error("Add your ElevenLabs API key and voice ID in Voice settings.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(voiceId)) throw new Error("Enter a valid ElevenLabs voice ID.");
  return { apiKey, voiceId, modelId: "eleven_flash_v2_5" };
}

/** Secrets and provider error bodies never cross IPC. No silent switch to a different voice. */
export async function synthesizeElevenLabsVoice(
  text: string,
  config: ElevenLabsVoiceConfig,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await request(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": config.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: config.modelId,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: "error",
      },
    );
  } catch {
    throw new Error(
      signal.aborted
        ? "Voice call ended."
        : "ElevenLabs could not be reached. Check your connection and try again.",
    );
  }
  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? "ElevenLabs access was refused. Check the API key and voice access."
        : response.status === 429
          ? "ElevenLabs is at its usage or request limit. Check your ElevenLabs account."
          : response.status === 404
            ? "The selected ElevenLabs voice was not found. Check the voice ID."
            : "ElevenLabs could not generate this reply. Try again.";
    await response.body?.cancel();
    throw new Error(message);
  }
  if (!response.headers.get("content-type")?.startsWith("audio/")) {
    await response.body?.cancel();
    throw new Error("ElevenLabs returned an invalid audio response.");
  }
  // Bound memory independently of Content-Length, which a streaming response may omit.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ElevenLabs returned no audio.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 20 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Audio too large.");
      }
      chunks.push(value);
    }
  } catch {
    throw new Error("ElevenLabs audio was interrupted or too large. Try again.");
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error("ElevenLabs returned no audio.");
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}
