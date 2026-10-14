import { useEffect, useRef, useState } from "react";
import { AudioLinesIcon, PlayIcon } from "lucide-react";
import type { DesktopLocalVoice, DesktopVoicePreferences } from "@specweave-studio/contracts";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";
import { Tip } from "./shell/Tip";
import { playCallAudio } from "../../studio/voiceCallAudio";

const DEFAULT: DesktopVoicePreferences = {
  provider: "local",
  localVoiceId: "",
  rate: 0.47,
  elevenLabsVoiceId: "",
  hasApiKey: false,
};
const fieldClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
export function VoiceSettings({ disabled = false }: { disabled?: boolean }) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(DEFAULT);
  const [voices, setVoices] = useState<readonly DesktopLocalVoice[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open || !bridge?.getVoicePreferences) return;
    let alive = true;
    setLoaded(false);
    setError(null);
    setApiKey("");
    setClearKey(false);
    void bridge
      .getVoicePreferences()
      .then((settings) => {
        if (alive) {
          setValue(settings);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setError("Could not load voice settings. Close and try again.");
      });
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
  if (!bridge?.getVoicePreferences || !bridge.setVoicePreferences) return null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await bridge.setVoicePreferences!({
        provider: value.provider,
        localVoiceId: value.localVoiceId,
        rate: value.rate,
        elevenLabsVoiceId: value.elevenLabsVoiceId,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        clearApiKey: clearKey,
      });
      setApiKey("");
      setOpen(false);
    } catch {
      setError(
        "Could not save. For ElevenLabs, add your own key and a valid voice ID. Secure storage must be available.",
      );
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
          onClick={() => setOpen(true)}
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
                    value.hasApiKey && !clearKey
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
                The key is encrypted on this device and is never synced to other users.
              </p>
            </>
          )}
          {value.hasApiKey && !clearKey ? (
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
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
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
