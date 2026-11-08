import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import type { DesktopBridge } from "@specweave-studio/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";

import { useDictationShortcut } from "../../src/components/studio/dictationShortcut";
import {
  insertDictatedText,
  useVoiceDictation,
  VoiceDictationBar,
  VoiceDictationButton,
} from "../../src/components/studio/VoiceDictation";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { shortcutLabelForCommand } from "../../src/keybindings";
import { applyThemePalette } from "../../src/themePalette";
import { mode } from "./mocks";
import "./fixture.css";

const ready = { supported: true, microphone: "granted", reason: null } as const;
const heard: Array<{ locale?: string; pinLanguage?: boolean }> = [];
(window as unknown as { heard: typeof heard }).heard = heard;
// "browser" is the web UI with no desktop bridge.
if (mode !== "browser")
  window.desktopBridge = {
    getClientPlatform: () => (mode === "windows" ? "win32" : mode),
    getSystemLocale: () => "en-US",
    getVoiceStatus: async () => ({ ...ready, setupBytes: 0 }),
    requestVoiceAccess: async () => ready,
    setVoiceCallActive: async () => {},
    transcribeVoice: async ({
      locale,
      pinLanguage,
    }: {
      locale?: string;
      pinLanguage?: boolean;
    }) => {
      heard.push({ ...(locale ? { locale } : {}), ...(pinLanguage ? { pinLanguage } : {}) });
      return "merge the SpecWeave pull request";
    },
    openMicrophoneSettings: async () => {},
  } as unknown as DesktopBridge;

const keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
const label = shortcutLabelForCommand(keybindings, "composer.dictation.toggle");
const pane = { border: "1px solid #333", borderRadius: 14, padding: 18, flex: 1 } as const;

/** The coordinator: its own message box, filled the way the real one is. */
function Coordinator() {
  const [message, setMessage] = useState("");
  const dictation = useVoiceDictation(setMessage, "project");
  const ref = useRef<HTMLElement | null>(null);
  useDictationShortcut({ dictation, root: ref, keybindings });
  return (
    <section ref={ref} data-pane="coordinator" style={pane}>
      <h2 style={{ marginBottom: 10 }}>Coordinator</h2>
      <VoiceDictationBar dictation={dictation} />
      <textarea
        id="project-prompt"
        aria-label="Coordinator message"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        style={{ width: "100%", height: 70 }}
      />
      <VoiceDictationButton dictation={dictation} disabled={false} shortcut={label} />
    </section>
  );
}

/** A thread composer: the same hook, bar and shortcut ChatComposer mounts, with its own insert. */
function Thread() {
  const [message, setMessage] = useState("");
  const box = useRef<HTMLTextAreaElement | null>(null);
  const dictation = useVoiceDictation(() => undefined, "thread", {
    insert: (text) =>
      setMessage((current) => {
        const focused = document.activeElement === box.current;
        const start = focused ? (box.current?.selectionStart ?? current.length) : current.length;
        return insertDictatedText(current, text, start).value;
      }),
  });
  const ref = useRef<HTMLFormElement | null>(null);
  useDictationShortcut({ dictation, root: ref, keybindings });
  return (
    <form ref={ref} data-pane="thread" style={pane}>
      <h2 style={{ marginBottom: 10 }}>Thread</h2>
      <VoiceDictationBar dictation={dictation} />
      <textarea
        ref={box}
        aria-label="Thread message"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        style={{ width: "100%", height: 70 }}
      />
      <VoiceDictationButton dictation={dictation} disabled={false} shortcut={label} />
    </form>
  );
}

function App() {
  return (
    <TooltipProvider>
      <main style={{ maxWidth: 1100, margin: "60px auto", padding: 24 }}>
        <p style={{ color: "#949494", marginBottom: 12 }}>
          SPECWITHCODE · ISOLATED DICTATION SHORTCUT CHECK · {mode}
        </p>
        <p id="shortcut" style={{ marginBottom: 16 }}>
          Dictation shortcut: {label ?? "none"}
        </p>
        <div style={{ display: "flex", gap: 20 }}>
          <Coordinator />
          <Thread />
        </div>
      </main>
    </TooltipProvider>
  );
}
document.documentElement.classList.add("dark");
applyThemePalette("studio-chat", "dark");
document.body.style.background = "#181818";
createRoot(document.getElementById("root")!).render(<App />);
