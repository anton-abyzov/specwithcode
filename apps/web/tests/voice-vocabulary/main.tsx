import { createRoot } from "react-dom/client";
import type { DesktopBridge } from "@specweave-studio/contracts";

import { DictationSettings } from "../../src/components/settings/DictationSettings";
import { VoiceSettings } from "../../src/components/studio/VoiceSettings";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { applyThemePalette } from "../../src/themePalette";
import { mode, theme } from "./mocks";
import "./fixture.css";

/** What the desktop app answers: the person's own list, and the product's words beside it. */
const vocabulary = {
  text: "EasyChamp\nminus forum => Minisforum\nDevon => Devin",
  count: 3,
  refused: 0,
  builtIn: [
    "SpecWithCode",
    "SpecWeave",
    "worktree",
    "worktrees",
    "increment",
    "coordinator",
    "vskill",
    "Claude Code",
    "Claude",
    "Codex",
    "Devin",
    "Fable",
    "Opus",
    "Sonnet",
    "Ultracode",
    "MCP",
    "GitHub",
    "pull request",
    "handoff",
  ],
};
window.desktopBridge = {
  getClientPlatform: () => mode,
  getVoiceStatus: async () => ({ supported: true, microphone: "granted", reason: null }),
  synthesizeVoice: async () => new Uint8Array(),
  listLocalVoices: async () => [],
  readLegacyVoicePreferences: async () => null,
  readVoiceVocabulary: async () => vocabulary,
  saveVoiceVocabulary: async ({ text }: { text: string }) => ({ ...vocabulary, text }),
} as unknown as DesktopBridge;

function App() {
  return (
    <TooltipProvider>
      <main style={{ maxWidth: 760, margin: "40px auto", padding: 24 }}>
        <p style={{ marginBottom: 12, opacity: 0.6 }}>
          SPECWITHCODE · VOICE VOCABULARY AND LANGUAGE · {mode}
        </p>
        <VoiceSettings />
        <div style={{ marginTop: 24 }}>
          <DictationSettings />
        </div>
      </main>
    </TooltipProvider>
  );
}
if (theme === "dark") document.documentElement.classList.add("dark");
applyThemePalette("studio-chat", theme);
document.body.style.background = theme === "dark" ? "#181818" : "#ffffff";
createRoot(document.getElementById("root")!).render(<App />);
