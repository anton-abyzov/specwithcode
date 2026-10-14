// @effect-diagnostics nodeBuiltinImport:off -- Voice IPC drives a native helper process and its private temp files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import {
  DESKTOP_VOICE_MAX_AUDIO_BYTES,
  DesktopVoicePreferencesSchema,
  DesktopVoicePreferencesInputSchema,
  DesktopLocalVoiceSchema,
  DesktopLocalVoicePreviewSchema,
  DesktopVoiceStatusSchema,
  DesktopVoiceSynthesizeInputSchema,
  DesktopVoiceTranscribeInputSchema,
  type DesktopVoiceAccess,
  type DesktopVoiceStatus,
} from "@specweave-studio/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  synthesizeElevenLabsVoice,
} from "../../voice/elevenLabsVoice.ts";
import { VoicePreferencesStore } from "../../voice/voicePreferences.ts";
import { VoiceHelper, VoiceHelperError } from "../../voice/VoiceHelper.ts";
import { allowMediaPermission, MICROPHONE_SETTINGS_URL } from "../../voice/voicePermission.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  VOICE_GET_STATUS_CHANNEL,
  VOICE_GET_PREFERENCES_CHANNEL,
  VOICE_SET_PREFERENCES_CHANNEL,
  VOICE_LIST_LOCAL_CHANNEL,
  VOICE_PREVIEW_LOCAL_CHANNEL,
  VOICE_OPEN_MICROPHONE_SETTINGS_CHANNEL,
  VOICE_REQUEST_ACCESS_CHANNEL,
  VOICE_SET_CALL_ACTIVE_CHANNEL,
  VOICE_SYNTHESIZE_CHANNEL,
  VOICE_TRANSCRIBE_CHANNEL,
} from "../channels.ts";

export const VOICE_HELPER_EXECUTABLE_NAME = "studio-voice";
const VOICE_PREPARE_TIMEOUT_MS = 15 * 60_000;

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

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof VoiceHelperError) return error.message;
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

export const installVoice = Effect.fn("desktop.ipc.installVoice")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const isMac = environment.platform === "darwin";
  const preferences = new VoicePreferencesStore(
    NodePath.join(environment.stateDir, "voice-preferences.json"),
    Electron.safeStorage,
  );
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

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_GET_PREFERENCES_CHANNEL,
      payload: Schema.Void,
      result: DesktopVoicePreferencesSchema,
      handler: () => Effect.promise(() => preferences.get()),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_SET_PREFERENCES_CHANNEL,
      payload: DesktopVoicePreferencesInputSchema,
      result: DesktopVoicePreferencesSchema,
      handler: (input) => Effect.promise(() => preferences.set(input)),
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
          if (!isMac) return { ok: false as const, error: "Local voice preview needs macOS." };
          try {
            const voice = await getHelper();
            const audio = await withTempFile("wav", async (path) => {
              await voice.request({
                op: "speak",
                text: "Hello. I am ready when you are. We can review your projects, or start something new.",
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

  const status = (): DesktopVoiceStatus =>
    isMac
      ? { supported: true, microphone: microphoneAccess(), reason: null }
      : {
          supported: false,
          microphone: "unknown",
          reason: "Voice calls need the SpecWithCode app on macOS.",
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
      handler: () => Effect.sync(status),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_REQUEST_ACCESS_CHANNEL,
      payload: Schema.Void,
      result: DesktopVoiceStatusSchema,
      handler: () =>
        Effect.promise(async () => {
          if (!isMac) return status();
          if (microphoneAccess() === "not-determined") {
            await Electron.systemPreferences.askForMediaAccess("microphone").catch(() => false);
          }
          return status();
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
          // Load the speech model while the caller starts talking.
          void getHelper()
            .then((voice) =>
              // A first use may download the speech model; that can take minutes.
              voice.request(
                { op: "prepare", locale: defaultLocale() },
                { timeoutMs: VOICE_PREPARE_TIMEOUT_MS },
              ),
            )
            .catch(() => undefined);
        }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_TRANSCRIBE_CHANNEL,
      payload: DesktopVoiceTranscribeInputSchema,
      result: VoiceTextResult,
      handler: ({ audio, locale }, event) =>
        Effect.promise(async () => {
          if (!isMac) return { ok: false as const, error: status().reason ?? "Unsupported." };
          if (event === undefined || !activeCalls.has(event.sender.id)) {
            return { ok: false as const, error: "No voice call is active in this window." };
          }
          if (audio.byteLength === 0 || audio.byteLength > DESKTOP_VOICE_MAX_AUDIO_BYTES) {
            return { ok: false as const, error: "That recording was too long to transcribe." };
          }
          try {
            const voice = await getHelper();
            const text = await withTempFile("wav", async (path) => {
              await NodeFSP.writeFile(path, audio, { mode: 0o600 });
              const reply = await voice.request({
                op: "transcribe",
                path,
                locale: locale ?? defaultLocale(),
              });
              return reply.text ?? "";
            });
            return { ok: true as const, text };
          } catch (error) {
            return { ok: false as const, error: messageOf(error, "Could not transcribe.") };
          }
        }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_SYNTHESIZE_CHANNEL,
      payload: DesktopVoiceSynthesizeInputSchema,
      result: VoiceAudioResult,
      handler: ({ text }, event) =>
        Effect.promise(async () => {
          if (!isMac) return { ok: false as const, error: status().reason ?? "Unsupported." };
          if (event === undefined || !activeCalls.has(event.sender.id)) {
            return { ok: false as const, error: "No voice call is active in this window." };
          }
          const senderId = event.sender.id;
          speechRequests.get(senderId)?.abort();
          const request = new AbortController();
          speechRequests.set(senderId, request);
          try {
            const settings = await preferences.speechConfig();
            if (request.signal.aborted) return { ok: false as const, error: "Voice call ended." };
            const cloudVoice = settings.cloud;
            if (cloudVoice) {
              const audio = await synthesizeElevenLabsVoice(text, cloudVoice, request.signal);
              if (request.signal.aborted) return { ok: false as const, error: "Voice call ended." };
              return { ok: true as const, audio };
            }
            const voice = await getHelper();
            if (request.signal.aborted) return { ok: false as const, error: "Voice call ended." };
            const audio = await withTempFile("wav", async (path) => {
              if (request.signal.aborted) throw new Error("Voice call ended.");
              await voice.request({
                op: "speak",
                text,
                path,
                voice: settings.localVoiceId || undefined,
                rate: settings.rate,
              });
              return new Uint8Array(await NodeFSP.readFile(path));
            });
            return request.signal.aborted
              ? { ok: false as const, error: "Voice call ended." }
              : { ok: true as const, audio };
          } catch (error) {
            return {
              ok: false as const,
              error: messageOf(error, "Could not read the reply aloud."),
            };
          } finally {
            if (speechRequests.get(senderId) === request) speechRequests.delete(senderId);
          }
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
        }),
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
