import { MicIcon, SettingsIcon, SquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  encodeWavPcm16,
  resampleLinear,
  UtteranceDetector,
  VOICE_CALL_SAMPLE_RATE,
  type VoiceCallMicrophone,
  rootMeanSquare,
} from "@specweave-studio/client-runtime/voice-call";
import type { DesktopBridge } from "@specweave-studio/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { openCallMicrophone } from "../../studio/voiceCallAudio";
import { canHostVoiceCall } from "../../studio/voiceCallSupport";
import { COORDINATOR_PROMPT_ID } from "./CoordinatorQuestionCard";
import { isVoiceCallLive, stopOtherDictation } from "./dictationShortcut";
import { Tip } from "./shell/Tip";
import { useVoiceSetupPercent, VoiceConsentDialog } from "./VoiceCall";

type DictationBridge = Required<
  Pick<
    DesktopBridge,
    "getVoiceStatus" | "requestVoiceAccess" | "setVoiceCallActive" | "transcribeVoice"
  >
> &
  Pick<DesktopBridge, "getSystemLocale" | "openMicrophoneSettings">;

function dictationBridge(): DictationBridge | null {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge || !canHostVoiceCall(bridge)) return null;
  const { getVoiceStatus, requestVoiceAccess, setVoiceCallActive, transcribeVoice } = bridge;
  if (!getVoiceStatus || !requestVoiceAccess || !setVoiceCallActive || !transcribeVoice)
    return null;
  return bridge as DictationBridge;
}

/** Puts a phrase at the cursor, with one space between it and what surrounds it. */
export function insertDictatedText(
  current: string,
  text: string,
  start: number = current.length,
  end: number = start,
): { readonly value: string; readonly caret: number } {
  const before = current.slice(0, start);
  const after = current.slice(end);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  const inserted = `${lead}${text}${trail}`;
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

type Phase = "idle" | "starting" | "listening" | "finishing" | "error";

type Session = {
  microphone: VoiceCallMicrophone | null;
  detector: UtteranceDetector | null;
  /** Phrases are transcribed one after another so they land in spoken order. */
  queue: Promise<void>;
  pending: number;
  wrote: boolean;
  dropped: boolean;
  /** stop() ran: the microphone is closed and the queue is being written out. */
  stopping: boolean;
  failures: number;
  /** When the last phrase ended (or listening began); null while one is being spoken. */
  quietSince: number | null;
};

const MAX_FAILED_PHRASES = 3;
/** A forgotten microphone turns itself off after this long without speech. */
export const DICTATION_SILENCE_STOP_MS = 60_000;
const NOTHING_HEARD =
  "No speech was heard. Check that the microphone is plugged in and selected in Sound settings.";

export type VoiceDictation = ReturnType<typeof useVoiceDictation>;

/** Puts one finished phrase into a composer, at its caret when it has focus. */
export type DictationInsert = (text: string) => void;

/**
 * Dictation into a message box: the coordinator's by default, or any composer
 * that passes `insert`. Pressing the button or the shortcut opens the
 * microphone and each finished phrase lands at the cursor, unsent. Leaving the
 * project or the page closes the microphone and drops anything still queued.
 * The language comes from Settings, one value for the whole app.
 */
export function useVoiceDictation(
  setPrompt: (update: (current: string) => string) => void,
  scope: string,
  options?: { readonly insert?: DictationInsert },
) {
  const bridge = dictationBridge();
  const allowed = useClientSettings((settings) => settings.voiceCallsAllowed);
  const language = useClientSettings((settings) => settings.dictationLanguage);
  const updateSettings = useUpdateClientSettings();
  const [phase, setPhase] = useState<Phase>("idle");
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const notice = useRef<string | null>(null);
  const setNotice = useCallback((text: string | null) => {
    notice.current = text;
    setNoticeText(text);
  }, []);
  const [consentOpen, setConsentOpen] = useState(false);
  const [setupBytes, setSetupBytes] = useState(0);
  const session = useRef<Session | null>(null);
  const [key] = useState(() => ({}));
  const attempt = useRef(0);
  const levelTarget = useRef<HTMLElement | null>(null);
  const setPromptRef = useRef(setPrompt);
  const insertRef = useRef(options?.insert);
  const languageRef = useRef(language);
  useLayoutEffect(() => {
    setPromptRef.current = setPrompt;
    insertRef.current = options?.insert;
    languageRef.current = language;
  });
  const setupPercent = useVoiceSetupPercent(bridge, phase === "starting");

  const insert = useCallback((text: string) => {
    if (insertRef.current) {
      insertRef.current(text);
      return;
    }
    const box = document.getElementById(COORDINATOR_PROMPT_ID);
    const focused = box instanceof HTMLTextAreaElement && document.activeElement === box;
    const selection = focused ? [box.selectionStart, box.selectionEnd] : null;
    let caret: number | null = null;
    setPromptRef.current((current) => {
      const next = selection
        ? insertDictatedText(current, text, selection[0], selection[1])
        : insertDictatedText(current, text);
      caret = next.caret;
      return next.value;
    });
    if (focused) {
      window.requestAnimationFrame(() => {
        if (caret !== null) box.setSelectionRange(caret, caret);
      });
    }
  }, []);

  // The desktop grants the microphone per window, not per composer: only the
  // composer that asked for it may hand it back, or it ends another's session.
  const owns = useRef(false);
  const release = useCallback(() => {
    if (!owns.current) return;
    owns.current = false;
    void bridge?.setVoiceCallActive({ active: false }).catch(() => undefined);
  }, [bridge]);

  const closeMicrophone = (current: Session) => {
    current.microphone?.close();
    current.microphone = null;
  };

  const fail = useCallback(
    (message: string) => {
      attempt.current += 1;
      const current = session.current;
      session.current = null;
      if (current) {
        current.dropped = true;
        closeMicrophone(current);
      }
      setWriting(false);
      setError(message);
      setPhase("error");
      release();
    },
    [release],
  );

  const enqueue = useCallback(
    (current: Session, samples: Float32Array, sampleRate: number) => {
      if (!bridge) return;
      const audio = encodeWavPcm16(
        resampleLinear(samples, sampleRate, VOICE_CALL_SAMPLE_RATE),
        VOICE_CALL_SAMPLE_RATE,
      );
      current.pending += 1;
      setWriting(true);
      current.queue = current.queue.then(async () => {
        try {
          if (current.dropped) return;
          const chosen = languageRef.current;
          const locale = chosen || (bridge.getSystemLocale?.() ?? undefined);
          const text = await bridge.transcribeVoice(
            chosen
              ? { audio, locale: chosen, pinLanguage: true }
              : locale
                ? { audio, locale }
                : { audio },
          );
          if (current.dropped || !text.trim()) return;
          current.wrote = true;
          current.failures = 0;
          setNotice(null);
          insert(text.trim());
        } catch (cause) {
          // One bad phrase must not lose the ones being spoken after it.
          if (!current.dropped) {
            const message = cause instanceof Error ? cause.message : "Could not transcribe that.";
            current.failures += 1;
            // A helper that keeps failing is broken: the microphone should not stay open for it.
            if (current.failures >= MAX_FAILED_PHRASES) fail(message);
            else setNotice(message);
          }
        } finally {
          current.pending -= 1;
          if (current.pending === 0 && session.current === current) setWriting(false);
        }
      });
    },
    [bridge, fail, insert, setNotice],
  );

  // The silence stop runs from the microphone callback, which connect sets up before stop exists.
  const stopRef = useRef<() => Promise<void>>(async () => undefined);

  const connect = useCallback(async () => {
    if (!bridge || session.current) return;
    const id = ++attempt.current;
    const cancelled = () => attempt.current !== id;
    setError(null);
    setNotice(null);
    setPhase("starting");
    const status = await bridge.requestVoiceAccess().catch(() => null);
    if (cancelled()) return;
    if (!status?.supported || status.microphone !== "granted") {
      fail(
        status?.reason ??
          "Microphone access is off for SpecWithCode. Turn it on in System Settings, then try again.",
      );
      return;
    }
    const current: Session = {
      microphone: null,
      detector: null,
      queue: Promise.resolve(),
      pending: 0,
      wrote: false,
      dropped: false,
      stopping: false,
      failures: 0,
      quietSince: null,
    };
    session.current = current;
    try {
      owns.current = true;
      await bridge.setVoiceCallActive({ active: true });
      if (cancelled()) return;
      const microphone = await openCallMicrophone((frame) => {
        if (current.dropped || !current.detector) return;
        levelTarget.current?.style.setProperty(
          "--voice-level",
          Math.min(1, rootMeanSquare(frame) * 12).toFixed(3),
        );
        for (const event of current.detector.push(frame)) {
          if (event.type === "speech-start") current.quietSince = null;
          if (event.type === "utterance") {
            current.quietSince = Date.now();
            enqueue(current, event.samples, event.sampleRate);
          }
        }
        if (
          !current.stopping &&
          current.quietSince !== null &&
          Date.now() - current.quietSince >= DICTATION_SILENCE_STOP_MS
        ) {
          void stopRef.current();
        }
      });
      if (cancelled()) {
        microphone.close();
        return;
      }
      current.microphone = microphone;
      current.detector = new UtteranceDetector(microphone.sampleRate, {
        endAfterSilenceMs: 800,
      });
      current.quietSince = Date.now();
      setPhase("listening");
    } catch (cause) {
      if (cancelled()) return;
      fail(cause instanceof Error ? cause.message : "Could not open the microphone.");
    }
  }, [bridge, enqueue, fail, setNotice]);

  /** Stops listening, and finishes writing what was already said. */
  const stop = useCallback(async () => {
    const current = session.current;
    // A second stop while the first writes out waits for it rather than cutting it short.
    if (current?.stopping) {
      await current.queue;
      return;
    }
    if (!current?.microphone) {
      // Still starting: the attempt must not open the microphone after this.
      attempt.current += 1;
      session.current = null;
      setPhase("idle");
      release();
      return;
    }
    current.stopping = true;
    closeMicrophone(current);
    for (const event of current.detector?.flush() ?? []) {
      if (event.type === "utterance") enqueue(current, event.samples, event.sampleRate);
    }
    current.detector = null;
    setPhase("finishing");
    await current.queue;
    if (session.current !== current) return;
    session.current = null;
    release();
    setWriting(false);
    if (current.wrote) {
      setPhase("idle");
    } else {
      setError(notice.current ?? NOTHING_HEARD);
      setPhase("error");
    }
  }, [enqueue, release]);

  useLayoutEffect(() => {
    stopRef.current = stop;
  });

  // Leaving the project or the page: microphone off now, nothing lands afterward.
  useEffect(
    () => () => {
      attempt.current += 1;
      const current = session.current;
      session.current = null;
      if (current) {
        current.dropped = true;
        closeMicrophone(current);
      }
      setPhase("idle");
      setWriting(false);
      release();
    },
    [scope],
  );

  const start = useCallback(async () => {
    if (!bridge || isVoiceCallLive()) return;
    // A stop while this is still checking (a held shortcut let go) wins.
    const id = attempt.current;
    // The desktop grants the microphone per window: one composer dictates at a time.
    await stopOtherDictation(key);
    // A download never starts unasked, even after an earlier yes or the Settings switch.
    const status = await bridge.getVoiceStatus().catch(() => null);
    if (attempt.current !== id) return;
    const bytes = status?.setupBytes ?? 0;
    setSetupBytes(bytes);
    if (!allowed || status === null || bytes > 0) {
      setConsentOpen(true);
      return;
    }
    void connect();
  }, [allowed, bridge, connect, key]);

  const allow = useCallback(() => {
    setConsentOpen(false);
    updateSettings({ voiceCallsAllowed: true });
    void connect();
  }, [connect, updateSettings]);

  const active = phase === "starting" || phase === "listening" || phase === "finishing";
  return {
    key,
    available: bridge !== null,
    active,
    phase,
    writing,
    error,
    notice: noticeText,
    setupPercent,
    consentOpen,
    setupBytes,
    start,
    stop,
    allow,
    cancelConsent: useCallback(() => setConsentOpen(false), []),
    dismiss: useCallback(() => {
      setError(null);
      setPhase("idle");
    }, []),
    openMicrophoneSettings: useCallback(() => {
      void bridge?.openMicrophoneSettings?.();
    }, [bridge]),
    setLevelTarget: useCallback((element: HTMLElement | null) => {
      levelTarget.current = element;
    }, []),
  };
}

/** The microphone button in a composer: beside the call button for the coordinator. */
export function VoiceDictationButton({
  dictation,
  disabled,
  shortcut = null,
}: {
  dictation: VoiceDictation;
  disabled: boolean;
  /** The dictation shortcut's label, shown in the tip. */
  shortcut?: string | null;
}) {
  if (!dictation.available) return null;
  const tip = dictation.active ? "Stop dictating" : "Dictate into the message";
  return (
    <>
      <Tip label={shortcut ? `${tip} (${shortcut})` : tip}>
        <button
          type="button"
          className={`sws-icon-button sws-voice-dictate-button${dictation.active ? " sws-icon-button-on" : ""}`}
          aria-label={dictation.active ? "Stop dictating" : "Dictate into the message"}
          aria-pressed={dictation.active}
          disabled={dictation.phase === "finishing" || (disabled && !dictation.active)}
          onClick={() => void (dictation.active ? dictation.stop() : dictation.start())}
        >
          <MicIcon aria-hidden />
        </button>
      </Tip>
      <VoiceConsentDialog
        open={dictation.consentOpen}
        setupBytes={dictation.setupBytes}
        onCancel={dictation.cancelConsent}
        onAllow={dictation.allow}
        allowLabel="Allow and dictate"
      />
    </>
  );
}

/** The strip above the composer while dictating: what is happening, and how to stop. */
export function VoiceDictationBar({ dictation }: { dictation: VoiceDictation }) {
  const { phase } = dictation;
  if (phase === "idle") return null;
  if (phase === "error") {
    return (
      <div className="sws-voice-call" data-phase="error" role="alert">
        <p className="sws-voice-call-text">{dictation.error}</p>
        <span className="sws-voice-call-actions">
          {/Sound settings|System Settings/.test(dictation.error ?? "") ? (
            <Tip label="Open microphone settings">
              <button
                type="button"
                className="sws-icon-button"
                aria-label="Open microphone settings"
                onClick={dictation.openMicrophoneSettings}
              >
                <SettingsIcon aria-hidden />
              </button>
            </Tip>
          ) : null}
          <Tip label="Dismiss error">
            <button
              type="button"
              className="sws-icon-button"
              aria-label="Dismiss dictation error"
              onClick={dictation.dismiss}
            >
              <XIcon aria-hidden />
            </button>
          </Tip>
        </span>
      </div>
    );
  }
  const label =
    phase === "starting"
      ? "Getting ready…"
      : phase === "finishing"
        ? "Writing…"
        : dictation.writing
          ? "Listening · writing…"
          : "Listening";
  const caption =
    dictation.notice ??
    (phase === "starting" && dictation.setupPercent !== null
      ? `Downloading free speech files: ${dictation.setupPercent}%`
      : "Your words land in the message box. Nothing is sent until you send it.");
  return (
    <div
      className="sws-voice-call"
      data-phase={phase === "listening" ? "listening" : "transcribing"}
      ref={dictation.setLevelTarget}
    >
      <span className="sws-voice-dots" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="sws-voice-call-body">
        <span className="sws-voice-call-phase" role="status">
          {label}
        </span>
        <span className="sws-voice-call-text">{caption}</span>
      </span>
      <span className="sws-voice-call-actions">
        <Tip label="Stop dictating">
          <button
            type="button"
            className="sws-icon-button"
            aria-label="Stop dictating"
            disabled={phase === "finishing"}
            onClick={() => void dictation.stop()}
          >
            <SquareIcon aria-hidden />
          </button>
        </Tip>
      </span>
    </div>
  );
}
