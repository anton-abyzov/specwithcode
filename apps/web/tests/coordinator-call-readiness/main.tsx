import { createRoot } from "react-dom/client";
import { useVoiceCall, VoiceCallButton, VoiceCallBar } from "../../src/components/studio/VoiceCall";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { applyThemePalette } from "../../src/themePalette";
import { mode } from "./mocks";
import type { DesktopBridge } from "@specweave-studio/contracts";
import "./fixture.css";
const status = {
  supported: mode !== "unsupported",
  microphone: "granted",
  reason: mode === "unsupported" ? "Voice calls need the SpecWithCode app on macOS." : null,
} as const;
// "browser" is a page with no desktop bridge, like the web UI on a phone.
if (mode !== "browser")
  window.desktopBridge = {
    ...(mode === "windows" ? { getClientPlatform: () => "win32" } : {}),
    getVoiceStatus: async () => status,
    requestVoiceAccess: async () => {
      document.body.dataset.prepare = "called";
      return mode === "missing-helper"
        ? {
            ...status,
            supported: false,
            reason: "On-device speech is not available in this build.",
          }
        : status;
    },
    setVoiceCallActive: async () => {},
    transcribeVoice: async () => "",
    synthesizeVoice: async () => new Uint8Array(),
    openMicrophoneSettings: async () => {},
  } as unknown as DesktopBridge;
function App() {
  const call = useVoiceCall(
    async () => null,
    mode === "provider-missing"
      ? "Connect a provider in Settings > Providers and choose a coordinator model first."
      : null,
  );
  return (
    <TooltipProvider>
      <main
        style={{
          maxWidth: 760,
          margin: "100px auto",
          padding: 36,
          border: "1px solid #333",
          borderRadius: 18,
        }}
      >
        <p style={{ color: "#949494", marginBottom: 12 }}>
          SPECWITHCODE · ISOLATED READINESS CHECK
        </p>
        <h1 style={{ fontSize: 32, marginBottom: 14 }}>Call the coordinator</h1>
        <p style={{ color: "#aaa", marginBottom: 26 }}>
          No account credentials, microphone recording or paid requests are used in this fixture.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <VoiceCallButton call={call} disabled={false} />
          <span id="readiness">
            {call.unavailableReason ??
              "Ready. Free macOS speech; your selected coordinator provider."}
          </span>
        </div>
        <div style={{ marginTop: 24 }}>
          <VoiceCallBar call={call} />
        </div>
        <output id="phase">{call.state.phase}</output>
      </main>
    </TooltipProvider>
  );
}
document.documentElement.classList.add("dark");
applyThemePalette("studio-chat", "dark");
document.body.style.background = "#181818";
createRoot(document.getElementById("root")!).render(<App />);
