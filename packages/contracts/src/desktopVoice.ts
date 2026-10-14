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

export const DesktopVoiceSynthesizeInputSchema = Schema.Struct({
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DESKTOP_VOICE_MAX_SPOKEN_CHARACTERS),
  ),
});

export const DesktopVoicePreferencesSchema = Schema.Struct({
  provider: Schema.Literals(["local", "elevenlabs"]),
  localVoiceId: Schema.String,
  rate: Schema.Number.check(Schema.isBetween({ minimum: 0.35, maximum: 0.6 })),
  elevenLabsVoiceId: Schema.String,
  hasApiKey: Schema.Boolean,
});
export type DesktopVoicePreferences = typeof DesktopVoicePreferencesSchema.Type;
export const DesktopVoicePreferencesInputSchema = Schema.Struct({
  provider: Schema.Literals(["local", "elevenlabs"]),
  localVoiceId: Schema.String.check(Schema.isMaxLength(200)),
  rate: Schema.Number.check(Schema.isBetween({ minimum: 0.35, maximum: 0.6 })),
  elevenLabsVoiceId: Schema.String.check(Schema.isMaxLength(100)),
  apiKey: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  clearApiKey: Schema.optionalKey(Schema.Boolean),
});
export type DesktopVoicePreferencesInput = typeof DesktopVoicePreferencesInputSchema.Type;
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
