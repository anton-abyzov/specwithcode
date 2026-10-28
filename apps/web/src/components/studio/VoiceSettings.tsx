import { useEffect, useRef, useState } from "react";
import { AudioLinesIcon, PlayIcon } from "lucide-react";
import type {
  DesktopLocalVoice,
  VoiceSettings as VoiceSettingsValue,
} from "@specweave-studio/contracts";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";
import { Tip } from "./shell/Tip";
import { playCallAudio } from "../../studio/voiceCallAudio";
import { canHostVoiceCall } from "../../studio/voiceCallSupport";

let legacyImport: Promise<void> | null = null;

/**
 * Moves voice settings an earlier build kept on this Mac into the server once.
 * Server settings that were already changed win; the local file is deleted
 * only after the server has accepted the move.
 */
function importLegacyVoiceSettings(
  bridge: NonNullable<Window["desktopBridge"]>,
  saved: VoiceSettingsValue,
  save: (voice: Partial<VoiceSettingsValue>) => Promise<VoiceSettingsValue | null>,
): Promise<void> {
  legacyImport ??= (async () => {
    const legacy = await bridge.readLegacyVoicePreferences?.().catch(() => null);
    if (!legacy) return;
    const untouched =
      saved.provider === "local" &&
      saved.elevenLabsApiKey.length === 0 &&
      saved.elevenLabsVoiceId.length === 0 &&
      saved.localVoiceId.length === 0;
    if (untouched) {
      const { apiKey, ...rest } = legacy;
      const stored = await save({ ...rest, ...(apiKey ? { elevenLabsApiKey: apiKey } : {}) });
      // A server without voice settings accepts the patch but drops it; keep the file then.
      if (
        stored === null ||
        stored.provider !== legacy.provider ||
        stored.elevenLabsVoiceId !== legacy.elevenLabsVoiceId ||
        (apiKey.length > 0 && stored.elevenLabsApiKey.length === 0)
      ) {
        legacyImport = null;
        return;
      }
    }
    await bridge.forgetLegacyVoicePreferences?.().catch(() => undefined);
  })();
  return legacyImport;
}

const fieldClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
/**
 * One voice for every project on this Mac: saved in the primary server's
 * settings, with the ElevenLabs key in that server's secret store. The key is
 * write-only here; the server only reports whether one is saved.
 */
export function VoiceSettings({ disabled = false }: { disabled?: boolean }) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const environmentId = usePrimaryEnvironmentId();
  const saved = usePrimarySettings((settings) => settings.voice);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save voice settings",
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<VoiceSettingsValue>(saved);
  const [voices, setVoices] = useState<readonly DesktopLocalVoice[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useRef<AbortController | null>(null);
  // Waits for the server's real settings, so defaults are never mistaken for "untouched".
  const settingsLoaded = useAtomValue(primaryServerConfigAtom) !== null;
  useEffect(() => {
    if (!bridge || environmentId === null || !settingsLoaded) return;
    void importLegacyVoiceSettings(bridge, saved, async (voice) => {
      const result = await updateSettings({ environmentId, input: { patch: { voice } } });
      return result._tag === "Success" ? result.value.voice : null;
    });
  }, [bridge, environmentId, settingsLoaded, saved, updateSettings]);
  const hasApiKey = saved.elevenLabsApiKey.length > 0;
  const loaded = environmentId !== null;
  // Each opening starts from what the server has; edits stay local until saved.
  const openDialog = () => {
    setValue(saved);
    setError(null);
    setApiKey("");
    setClearKey(false);
    setOpen(true);
  };
  useEffect(() => {
    if (!open || !bridge) return;
    let alive = true;
    void bridge
      .listLocalVoices?.()
      .then((list) => {
        if (alive)
          setVoices(
            [...list].sort(
              (a, b) =>
                b.quality - a.quality ||
                a.language.localeCompare(b.language) ||
                a.name.localeCompare(b.name),
            ),
          );
      })
      .catch(() => {
        /* Automatic still works; preview reports a helper failure. */
      });
    return () => {
      alive = false;
      preview.current?.abort();
      setApiKey("");
    };
  }, [open, bridge]);
  if (!bridge?.synthesizeVoice || !canHostVoiceCall(bridge)) return null;
  const save = async () => {
    if (environmentId === null) return;
    const key = apiKey.trim();
    const voiceId = value.elevenLabsVoiceId.trim();
    if (value.provider === "elevenlabs") {
      if ((!key && (!hasApiKey || clearKey)) || !voiceId) {
        setError("Add your own ElevenLabs API key and voice ID first.");
        return;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(voiceId)) {
        setError("Enter a valid ElevenLabs voice ID.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            voice: {
              provider: value.provider,
              localVoiceId: value.localVoiceId,
              rate: value.rate,
              elevenLabsVoiceId: voiceId,
              // An omitted key keeps the saved one; an empty one removes it.
              ...(key ? { elevenLabsApiKey: key } : clearKey ? { elevenLabsApiKey: "" } : {}),
            },
          },
        },
      });
      if (result._tag !== "Success") {
        setError("Could not save voice settings. Try again.");
        return;
      }
      if (result.value.voice.provider !== value.provider) {
        setError("Update the SpecWithCode service on this Mac to save voice settings.");
        return;
      }
      setApiKey("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  const listen = async () => {
    if (!bridge.previewLocalVoice) return;
    preview.current?.abort();
    const controller = new AbortController();
    preview.current = controller;
    setPreviewing(true);
    setError(null);
    try {
      const audio = await bridge.previewLocalVoice({
        voiceId: value.localVoiceId,
        rate: value.rate,
      });
      await playCallAudio(audio, controller.signal);
    } catch {
      if (!controller.signal.aborted) setError("Could not preview the voice. Try Automatic.");
    } finally {
      if (preview.current === controller) {
        preview.current = null;
        setPreviewing(false);
      }
    }
  };
  return (
    <>
      <Tip label={disabled ? "End the call to change voice settings" : "Voice settings"}>
        <button
          type="button"
          className="sws-icon-button"
          aria-label="Voice settings"
          disabled={disabled}
          onClick={openDialog}
        >
          <AudioLinesIcon aria-hidden />
        </button>
      </Tip>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogPopup className="max-h-[calc(100dvh-3rem)] w-full space-y-4 overflow-y-auto p-6">
          <DialogTitle>Voice</DialogTitle>
          <DialogDescription>
            Speak naturally, without a speech subscription. Your agent’s usual text usage still
            applies.
          </DialogDescription>
          <label className="block space-y-1 text-sm">
            Voice service
            <select
              className={fieldClass}
              aria-label="Voice service"
              value={value.provider}
              disabled={!loaded || busy}
              onChange={(e) =>
                setValue({ ...value, provider: e.target.value as "local" | "elevenlabs" })
              }
            >
              <option value="local">On this Mac · Free</option>
              <option value="elevenlabs">ElevenLabs · Your own key</option>
            </select>
          </label>
          {value.provider === "local" ? (
            <>
              <label className="block space-y-1 text-sm">
                Local voice
                <select
                  className={fieldClass}
                  aria-label="Local voice"
                  value={value.localVoiceId}
                  onChange={(e) => setValue({ ...value, localVoiceId: e.target.value })}
                >
                  <option value="">Automatic · Best installed voice</option>
                  {voices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name} · {voice.language}
                      {voice.quality >= 3 ? " · Premium" : voice.quality >= 2 ? " · Enhanced" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-sm">
                Speaking pace
                <select
                  className={fieldClass}
                  aria-label="Speaking pace"
                  value={value.rate}
                  onChange={(e) => setValue({ ...value, rate: Number(e.target.value) })}
                >
                  <option value={0.42}>Relaxed</option>
                  <option value={0.47}>Natural</option>
                  <option value={0.52}>Brisk</option>
                </select>
              </label>
              <p className="text-sm text-muted-foreground">
                Audio is generated on this Mac. For richer voices, download an Enhanced or Premium
                voice in macOS Accessibility → Read &amp; Speak (Spoken Content on older macOS).
              </p>
              <Button
                variant="outline"
                disabled={!loaded || previewing || busy}
                onClick={() => void listen()}
              >
                <PlayIcon aria-hidden />
                {previewing ? "Playing…" : "Preview free voice"}
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                ElevenLabs receives reply text and charges your ElevenLabs account. Your microphone
                audio stays on this Mac. SpecWithCode does not cover these charges.
              </p>
              <label className="block space-y-1 text-sm">
                Your ElevenLabs API key
                <input
                  className={fieldClass}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="ElevenLabs API key"
                  value={apiKey}
                  placeholder={
                    hasApiKey && !clearKey
                      ? "Saved securely · leave blank to keep"
                      : "Enter your API key"
                  }
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setClearKey(false);
                  }}
                />
              </label>
              <label className="block space-y-1 text-sm">
                Voice ID
                <input
                  className={fieldClass}
                  aria-label="ElevenLabs voice ID"
                  value={value.elevenLabsVoiceId}
                  onChange={(e) => setValue({ ...value, elevenLabsVoiceId: e.target.value })}
                  placeholder="Copy from your ElevenLabs voice library"
                />
              </label>
              <p className="text-xs text-muted-foreground">
                One setting for every project. The key stays in the SpecWithCode service's secret
                store on this Mac and is never shown again or synced to other machines.
              </p>
            </>
          )}
          {hasApiKey && !clearKey ? (
            <Button
              variant="ghost"
              onClick={() => {
                setClearKey(true);
                setApiKey("");
                setValue({ ...value, provider: "local" });
              }}
            >
              Remove saved key and use free voice
            </Button>
          ) : null}
          <div className="rounded-lg border border-border p-3 text-sm">
            <span className="font-medium">Managed premium voice</span>
            <span className="ml-2 text-xs text-muted-foreground">Coming soon</span>
            <p className="mt-1 text-muted-foreground">
              Included usage and spending controls. No payment or sign-up is available yet.
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!loaded || busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save voice"}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
