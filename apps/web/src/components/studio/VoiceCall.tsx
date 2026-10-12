import { MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  VoiceCallController,
  type VoiceCallState,
} from "@specweave-studio/client-runtime/voice-call";
import type { DesktopBridge } from "@specweave-studio/contracts";

import { isElectron } from "../../env";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { CoordinatorReplyWaiter, type CoordinatorReplySnapshot } from "../../studio/voiceCallReply";
import { openCallMicrophone, playCallAudio } from "../../studio/voiceCallAudio";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Tip } from "./shell/Tip";

type VoiceBridge = Required<
  Pick<
    DesktopBridge,
    | "getVoiceStatus"
    | "requestVoiceAccess"
    | "setVoiceCallActive"
    | "transcribeVoice"
    | "synthesizeVoice"
    | "openMicrophoneSettings"
  >
> &
  Pick<DesktopBridge, "getSystemLocale">;

function voiceBridge(): VoiceBridge | null {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!isElectron || !bridge) return null;
  const {
    getVoiceStatus,
    requestVoiceAccess,
    setVoiceCallActive,
    transcribeVoice,
    synthesizeVoice,
    openMicrophoneSettings,
  } = bridge;
  if (
    !getVoiceStatus ||
    !requestVoiceAccess ||
    !setVoiceCallActive ||
    !transcribeVoice ||
    !synthesizeVoice ||
    !openMicrophoneSettings
  )
    return null;
  return bridge as VoiceBridge;
}

/**
 * Sends what the caller said to the coordinator and resolves with its answer,
 * read from the same conversation the page shows.
 */
export function useCoordinatorVoiceAsk(
  snapshot: CoordinatorReplySnapshot,
  send: (text: string) => Promise<void>,
): (text: string, signal: AbortSignal) => Promise<string | null> {
  const latest = useRef(snapshot);
  const sendRef = useRef(send);
  const waiters = useRef(new Set<(snapshot: CoordinatorReplySnapshot) => void>());
  useLayoutEffect(() => {
    latest.current = snapshot;
    sendRef.current = send;
  });
  useEffect(() => {
    // A waiter that settles removes itself; Set iteration tolerates that.
    for (const observe of waiters.current) observe(snapshot);
  }, [snapshot]);
  useEffect(() => {
    // A finished turn's answer can arrive without any further change to wait on.
    const timer = window.setInterval(() => {
      for (const observe of waiters.current) observe(latest.current);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return useCallback(async (text, signal) => {
    if (!latest.current.loaded) {
      // Without the conversation so far, any old reply would look like the answer.
      throw new Error("The coordinator conversation is still loading. Try again in a moment.");
    }
    const waiter = new CoordinatorReplyWaiter(latest.current, text);
    let stopWaiting = () => {};
    const answer = new Promise<string | null>((resolve, reject) => {
      const observe = (current: CoordinatorReplySnapshot) => {
        const outcome = waiter.observe(current, Date.now());
        if (outcome.kind === "pending") return;
        stopWaiting();
        if (outcome.kind === "failed") reject(new Error(outcome.message));
        else resolve(outcome.text);
      };
      const abort = () => {
        stopWaiting();
        reject(new DOMException("Call ended", "AbortError"));
      };
      stopWaiting = () => {
        waiters.current.delete(observe);
        signal.removeEventListener("abort", abort);
      };
      waiters.current.add(observe);
      signal.addEventListener("abort", abort, { once: true });
    });
    // A failed send rejects through here; the reply promise is then never awaited.
    answer.catch(() => undefined);
    try {
      await sendRef.current(text);
    } catch (error) {
      stopWaiting();
      throw error;
    }
    return answer;
  }, []);
}

const IDLE: VoiceCallState = {
  phase: "idle",
  muted: false,
  heard: null,
  spoken: null,
  notice: null,
  error: null,
};

const PHASE_LABEL: Record<VoiceCallState["phase"], string> = {
  idle: "",
  connecting: "Connecting…",
  listening: "Listening",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking",
  ended: "Call ended",
  error: "Call failed",
};

export type VoiceCall = ReturnType<typeof useVoiceCall>;

export function useVoiceCall(ask: (text: string, signal: AbortSignal) => Promise<string | null>) {
  const bridge = voiceBridge();
  const allowed = useClientSettings((settings) => settings.voiceCallsAllowed);
  const updateSettings = useUpdateClientSettings();
  const [state, setState] = useState<VoiceCallState>(IDLE);
  const [consentOpen, setConsentOpen] = useState(false);
  const [microphoneBlocked, setMicrophoneBlocked] = useState(false);
  const levelTarget = useRef<HTMLElement | null>(null);
  const controller = useRef<VoiceCallController | null>(null);
  const askRef = useRef(ask);
  useLayoutEffect(() => {
    askRef.current = ask;
  });
  const setLevelTarget = useCallback((element: HTMLElement | null) => {
    levelTarget.current = element;
  }, []);

  // Each connect attempt gets a number; hanging up or leaving moves it on, so
  // an attempt still waiting on the macOS prompt never opens the microphone.
  const attempt = useRef(0);

  const end = useCallback(() => {
    attempt.current += 1;
    const call = controller.current;
    controller.current = null;
    if (call) call.end();
    else
      setState((current) =>
        current.phase === "connecting" ? { ...IDLE, phase: "ended" } : current,
      );
    void bridge?.setVoiceCallActive({ active: false }).catch(() => undefined);
  }, [bridge]);

  useEffect(() => end, [end]);

  const connect = useCallback(async () => {
    if (!bridge || controller.current) return;
    const id = ++attempt.current;
    const cancelled = () => attempt.current !== id;
    setMicrophoneBlocked(false);
    setState({ ...IDLE, phase: "connecting" });
    const status = await bridge.requestVoiceAccess().catch(() => null);
    if (cancelled()) return;
    if (
      !status?.supported ||
      status.microphone === "denied" ||
      status.microphone === "restricted"
    ) {
      setMicrophoneBlocked(status?.supported === true);
      setState({
        ...IDLE,
        phase: "error",
        error:
          status?.reason ??
          "Microphone access is off for SpecWithCode. Turn it on in System Settings, then call again.",
      });
      return;
    }
    try {
      await bridge.setVoiceCallActive({ active: true });
    } catch {
      if (cancelled()) return;
      setState({ ...IDLE, phase: "error", error: "Could not start the call. Try again." });
      return;
    }
    if (cancelled()) {
      void bridge.setVoiceCallActive({ active: false }).catch(() => undefined);
      return;
    }
    const locale = bridge.getSystemLocale?.() ?? undefined;
    const call: VoiceCallController = new VoiceCallController({
      openMicrophone: openCallMicrophone,
      transcribe: (audio) => bridge.transcribeVoice(locale ? { audio, locale } : { audio }),
      ask: (text, signal) => askRef.current(text, signal),
      synthesize: (text) => bridge.synthesizeVoice({ text }),
      play: playCallAudio,
      onStateChange: (next) => {
        setState(next);
        if (next.phase === "error") {
          setMicrophoneBlocked(next.error?.includes("System Settings") ?? false);
          if (controller.current === call) controller.current = null;
          void bridge.setVoiceCallActive({ active: false }).catch(() => undefined);
        }
      },
      onLevel: (level) => {
        levelTarget.current?.style.setProperty("--voice-level", Math.min(1, level * 12).toFixed(3));
      },
    });
    controller.current = call;
    await call.start();
  }, [bridge]);

  const start = useCallback(() => {
    if (!bridge) return;
    if (!allowed) {
      setConsentOpen(true);
      return;
    }
    void connect();
  }, [allowed, bridge, connect]);

  const allow = useCallback(() => {
    setConsentOpen(false);
    updateSettings({ voiceCallsAllowed: true });
    void connect();
  }, [connect, updateSettings]);

  const cancelConsent = useCallback(() => setConsentOpen(false), []);
  const dismiss = useCallback(() => setState(IDLE), []);
  const toggleMute = useCallback(() => {
    const call = controller.current;
    call?.setMuted(!call.getState().muted);
  }, []);
  const interrupt = useCallback(() => controller.current?.interrupt(), []);
  const openMicrophoneSettings = useCallback(() => {
    void bridge?.openMicrophoneSettings();
  }, [bridge]);

  const active = state.phase !== "idle" && state.phase !== "ended" && state.phase !== "error";
  return {
    available: bridge !== null,
    active,
    state,
    consentOpen,
    microphoneBlocked,
    setLevelTarget,
    start,
    end,
    allow,
    cancelConsent,
    dismiss,
    toggleMute,
    interrupt,
    openMicrophoneSettings,
  };
}

/** The phone button beside Attach in the coordinator composer. */
export function VoiceCallButton({ call, disabled }: { call: VoiceCall; disabled: boolean }) {
  if (!call.available) return null;
  return (
    <>
      <Tip label={call.active ? "End the voice call" : "Call the coordinator and talk"}>
        <button
          type="button"
          className={`sws-icon-button sws-voice-call-button${call.active ? " sws-icon-button-on" : ""}`}
          aria-label={call.active ? "End voice call" : "Start voice call"}
          aria-pressed={call.active}
          disabled={disabled && !call.active}
          onClick={call.active ? call.end : call.start}
        >
          {call.active ? <PhoneOffIcon aria-hidden /> : <PhoneIcon aria-hidden />}
        </button>
      </Tip>
      <AlertDialog
        open={call.consentOpen}
        onOpenChange={(open) => {
          if (!open) call.cancelConsent();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow voice calls?</AlertDialogTitle>
            <AlertDialogDescription>
              You talk, the coordinator answers out loud. The microphone is on only while a call is
              open, and you can mute or hang up at any time.
            </AlertDialogDescription>
            <AlertDialogDescription>
              What you say is turned into text on this Mac and sent as your message, so it shows in
              the conversation like anything you type. No audio is uploaded or saved. macOS will ask
              once for microphone access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Not now</AlertDialogClose>
            <Button onClick={call.allow}>Allow and call</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** The live call strip above the composer: animated dots, what was heard, controls. */
export function VoiceCallBar({ call }: { call: VoiceCall }) {
  const { state } = call;
  if (state.phase === "idle" || state.phase === "ended") return null;
  if (state.phase === "error") {
    return (
      <div className="sws-voice-call" data-phase="error" role="alert">
        <p className="sws-voice-call-text">{state.error}</p>
        <span className="sws-voice-call-actions">
          {call.microphoneBlocked ? (
            <Button size="sm" variant="outline" onClick={call.openMicrophoneSettings}>
              Open System Settings
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={call.dismiss}>
            Dismiss
          </Button>
        </span>
      </div>
    );
  }
  const caption =
    state.notice ??
    (state.phase === "speaking" && state.spoken
      ? state.spoken
      : state.heard
        ? `“${state.heard}”`
        : "Say something to the coordinator.");
  return (
    <div
      className="sws-voice-call"
      data-phase={state.phase}
      data-muted={state.muted || undefined}
      ref={call.setLevelTarget}
    >
      <span className="sws-voice-dots" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="sws-voice-call-body">
        <span className="sws-voice-call-phase" role="status">
          {state.muted ? "Muted" : PHASE_LABEL[state.phase]}
        </span>
        <span className="sws-voice-call-text" data-notice={state.notice ? true : undefined}>
          {caption}
        </span>
      </span>
      <span className="sws-voice-call-actions">
        {state.phase === "speaking" ? (
          <Button size="sm" variant="ghost" onClick={call.interrupt}>
            Stop
          </Button>
        ) : null}
        <Tip label={state.muted ? "Unmute" : "Mute"}>
          <button
            type="button"
            className="sws-icon-button"
            aria-label={state.muted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={state.muted}
            onClick={call.toggleMute}
          >
            {state.muted ? <MicOffIcon aria-hidden /> : <MicIcon aria-hidden />}
          </button>
        </Tip>
        <Tip label="Hang up">
          <button
            type="button"
            className="sws-icon-button sws-voice-hangup"
            aria-label="End voice call"
            onClick={call.end}
          >
            <PhoneOffIcon aria-hidden />
          </button>
        </Tip>
      </span>
    </div>
  );
}
