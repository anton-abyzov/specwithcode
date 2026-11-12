// @effect-diagnostics nodeBuiltinImport:off -- Voice IPC drives a native helper process and its private temp files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import {
  DESKTOP_VOICE_MAX_AUDIO_BYTES,
  DesktopLegacyVoicePreferencesSchema,
  DesktopLocalVoiceSchema,
  DesktopLocalVoicePreviewSchema,
  DesktopVoiceStatusSchema,
  DesktopVoiceSynthesizeInputSchema,
  DesktopVoiceTranscribeInputSchema,
  DesktopVoiceVocabularySchema,
  DesktopVoiceVocabularySaveInputSchema,
  type DesktopVoiceAccess,
  type DesktopVoiceStatus,
} from "@specweave-studio/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  legacyVoicePreferencePaths,
  readLegacyVoicePreferences,
  removeLegacyVoicePreferences,
} from "../../voice/legacyVoicePreferences.ts";
import { LinuxSpeech, LinuxSpeechError, whisperLanguage } from "../../voice/linuxSpeech.ts";
import { prepareVoiceCall } from "../../voice/voiceReadiness.ts";
import { VoiceVocabularyStore } from "../../voice/vocabularyStore.ts";
import {
  contextualStrings,
  correctTranscript,
  judgeTranscript,
  productWords,
  SPEECH_PEAK,
  wavPeak,
  wavSeconds,
  whisperPrompt,
  withProductVocabulary,
} from "../../voice/vocabulary.ts";
import { VoiceHelper, VoiceHelperError } from "../../voice/VoiceHelper.ts";
import { allowMediaPermission, MICROPHONE_SETTINGS_URL } from "../../voice/voicePermission.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  VOICE_GET_STATUS_CHANNEL,
  VOICE_LIST_LOCAL_CHANNEL,
  VOICE_READ_LEGACY_CHANNEL,
  VOICE_FORGET_LEGACY_CHANNEL,
  VOICE_PREVIEW_LOCAL_CHANNEL,
  VOICE_OPEN_MICROPHONE_SETTINGS_CHANNEL,
  VOICE_REQUEST_ACCESS_CHANNEL,
  VOICE_SET_CALL_ACTIVE_CHANNEL,
  VOICE_SYNTHESIZE_CHANNEL,
  VOICE_TRANSCRIBE_CHANNEL,
  VOICE_VOCABULARY_READ_CHANNEL,
  VOICE_VOCABULARY_SAVE_CHANNEL,
} from "../channels.ts";

export const VOICE_HELPER_EXECUTABLE_NAME = "studio-voice";
export const LINUX_WHISPER_EXECUTABLE_NAME = "whisper-cli";
const VOICE_PREPARE_TIMEOUT_MS = 15 * 60_000;
const VOICE_PREVIEW_TEXT =
  "Hello. I am ready when you are. We can review your projects, or start something new.";

/** Results cross IPC as values so the renderer sees a plain message, never an Effect failure. */
const VoiceTextResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), text: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
const VoiceAudioResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), audio: Schema.Uint8Array }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

function microphoneAccess(): DesktopVoiceAccess {
  try {
    const status = Electron.systemPreferences.getMediaAccessStatus("microphone");
    return status === "granted" ||
      status === "denied" ||
      status === "restricted" ||
      status === "not-determined"
      ? status
      : "unknown";
  } catch {
    return "unknown";
  }
}

function defaultLocale(): string {
  return Electron.app.getSystemLocale() || Electron.app.getLocale();
}

/** `und` is the dictation language setting's "detect it from my speech". */
function asksToDetect(locale: string | undefined): boolean {
  return /^und(?:[-_]|$)/i.test(locale ?? "");
}

/**
 * What one voice request did, written to the desktop trace on the request's own
 * span: engine, language, timings and outcome. Never the words or the audio.
 */
type VoiceTrace = Record<string, string | number>;

function failureDetail(error: unknown): string {
  if (error instanceof LinuxSpeechError) return error.detail ?? "refused";
  if (error instanceof VoiceHelperError) return error.code;
  return "failed";
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof VoiceHelperError || error instanceof LinuxSpeechError) return error.message;
  return error instanceof Error && error.message ? `${fallback} ${error.message}` : fallback;
}

async function exists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Packaged builds ship the helper in resources/voice. A development checkout
 * compiles native/voice/main.swift on first use.
 */
async function resolveHelperPath(input: {
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly rootDir: string;
}): Promise<string | null> {
  if (input.isPackaged) {
    const packaged = NodePath.join(input.resourcesPath, "voice", VOICE_HELPER_EXECUTABLE_NAME);
    return (await exists(packaged)) ? packaged : null;
  }
  const source = NodePath.join(input.rootDir, "native/voice/main.swift");
  const output = NodePath.join(input.rootDir, "native/voice/.build", VOICE_HELPER_EXECUTABLE_NAME);
  if (!(await exists(source))) return null;
  const [sourceStat, outputStat] = await Promise.all([
    NodeFSP.stat(source),
    NodeFSP.stat(output).catch(() => null),
  ]);
  if (outputStat && outputStat.mtimeMs >= sourceStat.mtimeMs) return output;
  await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile(
      "xcrun",
      ["--sdk", "macosx", "swiftc", "-O", "-o", output, source],
      { timeout: 180_000 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  return output;
}

/** Opens the desktop's own sound settings; only GNOME and KDE have a known way in. */
function openLinuxSoundSettings(desktop: string): void {
  const command = /gnome|unity|cinnamon/i.test(desktop)
    ? ["gnome-control-center", "sound"]
    : /kde/i.test(desktop)
      ? ["systemsettings", "kcm_pulseaudio"]
      : null;
  if (command === null) return;
  const [file, ...args] = command as [string, ...string[]];
  const child = NodeChildProcess.spawn(file, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

export const installVoice = Effect.fn("desktop.ipc.installVoice")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const isMac = environment.platform === "darwin";
  const isLinux = environment.platform === "linux";
  const voiceDir = NodePath.join(environment.baseDir, "voice");
  const vocabulary = new VoiceVocabularyStore(NodePath.join(voiceDir, "vocabulary.json"));
  const linux = isLinux
    ? new LinuxSpeech({
        voiceDir,
        arch: environment.processArch,
        whisperPath: environment.isPackaged
          ? NodePath.join(environment.resourcesPath, "voice", LINUX_WHISPER_EXECUTABLE_NAME)
          : NodePath.join(
              environment.rootDir,
              "native/voice/.build",
              LINUX_WHISPER_EXECUTABLE_NAME,
            ),
      })
    : null;
  const activeCalls = new Set<number>();
  const speechRequests = new Map<number, AbortController>();
  const watched = new Set<number>();
  let helper: VoiceHelper | null = null;
  let helperPath: Promise<string | null> | null = null;
  let workDir: Promise<string> | null = null;

  const getHelper = async (): Promise<VoiceHelper> => {
    if (helper) return helper;
    helperPath ??= resolveHelperPath(environment).catch(() => null);
    const path = await helperPath;
    if (!path) {
      helperPath = null;
      throw new VoiceHelperError("missing", "On-device speech is not available in this build.");
    }
    helper ??= new VoiceHelper(() => NodeChildProcess.spawn(path, [], { stdio: "pipe" }));
    return helper;
  };
  const getWorkDir = () => {
    workDir ??= NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "specwithcode-voice-"));
    return workDir;
  };
  const withTempFile = async <T>(extension: string, use: (path: string) => Promise<T>) => {
    const path = NodePath.join(await getWorkDir(), `${NodeCrypto.randomUUID()}.${extension}`);
    try {
      return await use(path);
    } finally {
      await NodeFSP.rm(path, { force: true });
    }
  };

  const legacyPaths = () => legacyVoicePreferencePaths(environment.stateDir, environment.baseDir);
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_READ_LEGACY_CHANNEL,
      payload: Schema.Void,
      result: Schema.NullOr(DesktopLegacyVoicePreferencesSchema),
      handler: () =>
        Effect.promise(async () =>
          readLegacyVoicePreferences(await legacyPaths(), Electron.safeStorage).catch(() => null),
        ),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_FORGET_LEGACY_CHANNEL,
      payload: Schema.Void,
      result: Schema.Void,
      handler: () => Effect.promise(async () => removeLegacyVoicePreferences(await legacyPaths())),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_LIST_LOCAL_CHANNEL,
      payload: Schema.Void,
      result: Schema.Array(DesktopLocalVoiceSchema),
      handler: () =>
        Effect.promise(async () =>
          isMac ? ((await (await getHelper()).request({ op: "voices" })).voices ?? []) : [],
        ),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_PREVIEW_LOCAL_CHANNEL,
      payload: DesktopLocalVoicePreviewSchema,
      result: VoiceAudioResult,
      handler: ({ voiceId, rate }) =>
        Effect.promise(async () => {
          if (linux !== null) {
            if (!(await linux.isSetUp())) {
              return {
                ok: false as const,
                error: "The free voice downloads with your first call or dictation.",
              };
            }
            try {
              const audio = await withTempFile("wav", async (path) => {
                await linux.speak(VOICE_PREVIEW_TEXT, path, rate);
                return new Uint8Array(await NodeFSP.readFile(path));
              });
              return { ok: true as const, audio };
            } catch (error) {
              return {
                ok: false as const,
                error: messageOf(error, "Could not preview the voice."),
              };
            }
          }
          if (!isMac)
            return { ok: false as const, error: "Local voice preview is not available here." };
          try {
            const voice = await getHelper();
            const audio = await withTempFile("wav", async (path) => {
              await voice.request({
                op: "speak",
                text: VOICE_PREVIEW_TEXT,
                voice: voiceId || undefined,
                rate,
                path,
              });
              return new Uint8Array(await NodeFSP.readFile(path));
            });
            return { ok: true as const, audio };
          } catch {
            return {
              ok: false as const,
              error: "Could not preview this local voice. Try Automatic.",
            };
          }
        }),
    }),
  );

  const status = async (): Promise<DesktopVoiceStatus> => {
    if (isMac) return { supported: true, microphone: microphoneAccess(), reason: null };
    if (linux === null) {
      return {
        supported: false,
        microphone: "unknown",
        reason: "Voice needs the SpecWithCode app on macOS or Linux.",
      };
    }
    const reason = await linux.unsupportedReason();
    if (reason !== null) return { supported: false, microphone: "unknown", reason };
    // Linux has no system privacy switch to read: the app's own consent dialog
    // and the per-window permission handler below are the gate.
    return {
      supported: true,
      microphone: "granted",
      reason: null,
      setupBytes: await linux.missingBytes(),
      setupPercent: linux.progressPercent(),
    };
  };

  const endCall = (senderId: number) => {
    activeCalls.delete(senderId);
    speechRequests.get(senderId)?.abort();
    speechRequests.delete(senderId);
    if (activeCalls.size === 0) helper?.stop();
  };

  // Electron grants every permission by default; keep that for everything
  // but the microphone, which a window gets only during its own call.
  Electron.session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
      callback(
        allowMediaPermission({
          permission,
          mediaTypes,
          requestingUrl: details.requestingUrl,
          pageUrl: contents.getURL(),
          callActive: activeCalls.has(contents.id),
        }),
      );
    },
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_GET_STATUS_CHANNEL,
      payload: Schema.Void,
      result: DesktopVoiceStatusSchema,
      handler: () => Effect.promise(status),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_REQUEST_ACCESS_CHANNEL,
      payload: Schema.Void,
      result: DesktopVoiceStatusSchema,
      handler: () =>
        Effect.promise(async () => {
          if (linux !== null) return prepareVoiceCall(await status(), () => linux.prepare());
          if (!isMac) return status();
          if (microphoneAccess() === "not-determined") {
            await Electron.systemPreferences.askForMediaAccess("microphone").catch(() => false);
          }
          return prepareVoiceCall(await status(), async () => {
            const voice = await getHelper();
            await voice.request(
              { op: "prepare", locale: defaultLocale() },
              { timeoutMs: VOICE_PREPARE_TIMEOUT_MS },
            );
          });
        }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_SET_CALL_ACTIVE_CHANNEL,
      payload: Schema.Struct({ active: Schema.Boolean }),
      result: Schema.Void,
      handler: ({ active }, event) =>
        Effect.sync(() => {
          if (event === undefined) return;
          const senderId = event.sender.id;
          if (!active) {
            endCall(senderId);
            return;
          }
          if (!watched.has(senderId)) {
            const contents = Electron.webContents.fromId(senderId);
            if (contents === undefined) return;
            watched.add(senderId);
            // A reload or a crashed renderer skips the page's own hang-up.
            const pageGone = () => endCall(senderId);
            contents.on("did-navigate", pageGone);
            contents.on("render-process-gone", pageGone);
            contents.once("destroyed", () => {
              watched.delete(senderId);
              endCall(senderId);
            });
          }
          activeCalls.add(senderId);
        }),
    }),
  );

  const transcribe = async (
    input: typeof DesktopVoiceTranscribeInputSchema.Type,
    senderId: number | undefined,
  ): Promise<{ readonly result: typeof VoiceTextResult.Type; readonly trace: VoiceTrace }> => {
    const { audio, locale, pinLanguage } = input;
    const refused = (error: string, outcome: string) => ({
      result: { ok: false as const, error },
      trace: { "voice.outcome": outcome },
    });
    if (!isMac && linux === null) {
      return refused((await status()).reason ?? "Unsupported.", "unsupported");
    }
    if (senderId === undefined || !activeCalls.has(senderId)) {
      return refused("No voice call is active in this window.", "inactive");
    }
    if (audio.byteLength === 0 || audio.byteLength > DESKTOP_VOICE_MAX_AUDIO_BYTES) {
      return refused("That recording was too long to transcribe.", "too-long");
    }
    // The language chosen in Settings, else this computer's. Whisper detects one only
    // when asked to: detecting costs a second pass and lets noise return as any language.
    const chosen = pinLanguage === true && locale ? locale : undefined;
    const spoken = asksToDetect(chosen) ? undefined : (chosen ?? defaultLocale());
    const language = linux !== null ? whisperLanguage(spoken) : (spoken ?? defaultLocale());
    const peak = wavPeak(audio);
    const seconds = wavSeconds(audio);
    const trace: VoiceTrace = {
      "voice.engine": linux !== null ? "whisper" : "apple",
      "voice.language": language,
      "voice.audioMs": Math.round(seconds * 1000),
      "voice.peak": Math.round(peak * 1000) / 1000,
    };
    // Whisper answers a recording with no speech in it with an invented sentence,
    // so it is never asked. Apple's recognizer hears a soft voice and stays silent otherwise.
    if (linux !== null && peak < SPEECH_PEAK) {
      return {
        result: { ok: true as const, text: "" },
        trace: { ...trace, "voice.outcome": "quiet" },
      };
    }
    const started = performance.now();
    const engineMs = () => Math.round(performance.now() - started);
    try {
      const terms = withProductVocabulary(await vocabulary.terms());
      const prompt = linux === null ? "" : whisperPrompt(terms);
      const heard = await withTempFile("wav", async (path) => {
        await NodeFSP.writeFile(path, audio, { mode: 0o600 });
        if (linux !== null) {
          return linux.transcribe(path, prompt, {
            seconds,
            ...(language === "auto" ? {} : { language }),
          });
        }
        const voice = await getHelper();
        const reply = await voice.request({
          op: "transcribe",
          path,
          locale: language,
          contextualStrings: contextualStrings(terms),
        });
        return reply.text ?? "";
      });
      const verdict = judgeTranscript(heard, {
        engine: linux !== null ? "whisper" : "apple",
        prompt,
        peak,
        terms,
        ...(language === "auto" ? {} : { language }),
      });
      const text = correctTranscript(verdict.text, terms);
      return {
        result: { ok: true as const, text },
        trace: {
          ...trace,
          "voice.engineMs": engineMs(),
          "voice.outcome": verdict.dropped ?? (text ? "text" : "empty"),
          "voice.characters": text.length,
          "voice.hintCharacters": prompt.length,
        },
      };
    } catch (error) {
      return {
        result: { ok: false as const, error: messageOf(error, "Could not transcribe.") },
        trace: {
          ...trace,
          "voice.engineMs": engineMs(),
          "voice.outcome": "error",
          "voice.error": failureDetail(error),
        },
      };
    }
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_TRANSCRIBE_CHANNEL,
      payload: DesktopVoiceTranscribeInputSchema,
      result: VoiceTextResult,
      handler: (input, event) =>
        Effect.gen(function* () {
          const heard = yield* Effect.promise(() => transcribe(input, event?.sender.id));
          yield* Effect.annotateCurrentSpan(heard.trace);
          return heard.result;
        }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_SYNTHESIZE_CHANNEL,
      payload: DesktopVoiceSynthesizeInputSchema,
      result: VoiceAudioResult,
      handler: ({ text, voiceId, rate }, event) =>
        Effect.gen(function* () {
          const started = performance.now();
          const outcome: { failure: string | null } = { failure: null };
          const result = yield* Effect.promise(async () => {
            if (!isMac && linux === null) {
              return { ok: false as const, error: (await status()).reason ?? "Unsupported." };
            }
            if (event === undefined || !activeCalls.has(event.sender.id)) {
              return { ok: false as const, error: "No voice call is active in this window." };
            }
            const senderId = event.sender.id;
            speechRequests.get(senderId)?.abort();
            const request = new AbortController();
            speechRequests.set(senderId, request);
            try {
              const voice = linux === null ? await getHelper() : null;
              if (request.signal.aborted) return { ok: false as const, error: "Voice call ended." };
              const audio = await withTempFile("wav", async (path) => {
                if (request.signal.aborted) throw new Error("Voice call ended.");
                if (linux !== null) {
                  await linux.speak(text, path, rate, request.signal);
                } else {
                  await voice?.request({
                    op: "speak",
                    text,
                    path,
                    voice: voiceId || undefined,
                    rate,
                  });
                }
                return new Uint8Array(await NodeFSP.readFile(path));
              });
              return request.signal.aborted
                ? { ok: false as const, error: "Voice call ended." }
                : { ok: true as const, audio };
            } catch (error) {
              outcome.failure = request.signal.aborted ? "cancelled" : failureDetail(error);
              return {
                ok: false as const,
                error: messageOf(error, "Could not read the reply aloud."),
              };
            } finally {
              if (speechRequests.get(senderId) === request) speechRequests.delete(senderId);
            }
          });
          yield* Effect.annotateCurrentSpan({
            "voice.engine": linux !== null ? "piper" : "apple",
            "voice.characters": text.length,
            "voice.engineMs": Math.round(performance.now() - started),
            "voice.outcome": result.ok ? "audio" : outcome.failure === null ? "refused" : "error",
            ...(outcome.failure === null ? {} : { "voice.error": outcome.failure }),
          });
          return result;
        }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_OPEN_MICROPHONE_SETTINGS_CHANNEL,
      payload: Schema.Void,
      result: Schema.Void,
      handler: () =>
        Effect.promise(async () => {
          if (isMac)
            await Electron.shell.openExternal(MICROPHONE_SETTINGS_URL).catch(() => undefined);
          if (isLinux) openLinuxSoundSettings(process.env.XDG_CURRENT_DESKTOP ?? "");
        }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_VOCABULARY_READ_CHANNEL,
      payload: Schema.Void,
      result: DesktopVoiceVocabularySchema,
      handler: () =>
        Effect.promise(async () => ({ ...(await vocabulary.read()), builtIn: productWords() })),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_VOCABULARY_SAVE_CHANNEL,
      payload: DesktopVoiceVocabularySaveInputSchema,
      result: DesktopVoiceVocabularySchema,
      handler: ({ text }) =>
        Effect.promise(async () => ({ ...(await vocabulary.save(text)), builtIn: productWords() })),
    }),
  );

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      helper?.stop();
      for (const request of speechRequests.values()) request.abort();
      speechRequests.clear();
      activeCalls.clear();
      Electron.session.defaultSession.setPermissionRequestHandler(null);
      if (workDir) {
        await NodeFSP.rm(await workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }),
  );
});
