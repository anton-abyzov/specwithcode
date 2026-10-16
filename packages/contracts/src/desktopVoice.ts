import * as Schema from "effect/Schema";

/**
 * Voice calls with the project coordinator (macOS). `microphone` mirrors the
 * system privacy state; `speech` says whether on-device speech is ready.
 */
export const DesktopVoiceAccessSchema = Schema.Literals([
  "granted",
  "denied",
  "restricted",
  "not-determined",
  "unknown",
]);
export type DesktopVoiceAccess = typeof DesktopVoiceAccessSchema.Type;

export const DesktopVoiceStatusSchema = Schema.Struct({
  supported: Schema.Boolean,
  microphone: DesktopVoiceAccessSchema,
  /** Why calls cannot run here, when `supported` is false. */
  reason: Schema.NullOr(Schema.String),
});
export type DesktopVoiceStatus = typeof DesktopVoiceStatusSchema.Type;

/** At most about two minutes of 16 kHz 16-bit mono audio per utterance. */
export const DESKTOP_VOICE_MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const DESKTOP_VOICE_MAX_SPOKEN_CHARACTERS = 4_000;

export const DesktopVoiceTranscribeInputSchema = Schema.Struct({
  audio: Schema.Uint8Array,
  locale: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(35))),
});

const SpokenText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(DESKTOP_VOICE_MAX_SPOKEN_CHARACTERS),
);

/** Local macOS speech; the voice and pace come from the server's voice settings. */
export const DesktopVoiceSynthesizeInputSchema = Schema.Struct({
  text: SpokenText,
  voiceId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  rate: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0.35, maximum: 0.6 }))),
});

/**
 * Voice settings an earlier build kept on this Mac, read once so the app can
 * move them into the server's settings. `apiKey` is empty when none was saved.
 */
export const DesktopLegacyVoicePreferencesSchema = Schema.Struct({
  provider: Schema.Literals(["local", "elevenlabs"]),
  localVoiceId: Schema.String,
  rate: Schema.Number,
  elevenLabsVoiceId: Schema.String,
  apiKey: Schema.String,
});
export type DesktopLegacyVoicePreferences = typeof DesktopLegacyVoicePreferencesSchema.Type;

/** A reply spoken by the server's cloud voice (ElevenLabs), with the key it keeps. */
export const VoiceSpeechInput = Schema.Struct({ text: SpokenText });
export const VoiceSpeechResult = Schema.Struct({
  /** Base64 MP3. */
  audio: Schema.String,
});
export type VoiceSpeechResult = typeof VoiceSpeechResult.Type;

export class VoiceSpeechError extends Schema.TaggedError<VoiceSpeechError>()("VoiceSpeechError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const DesktopLocalVoiceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  language: Schema.String,
  quality: Schema.Number,
});
export type DesktopLocalVoice = typeof DesktopLocalVoiceSchema.Type;
export const DesktopLocalVoicePreviewSchema = Schema.Struct({
  voiceId: Schema.String.check(Schema.isMaxLength(200)),
  rate: Schema.Number.check(Schema.isBetween({ minimum: 0.35, maximum: 0.6 })),
});
