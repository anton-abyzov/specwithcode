// Synthetic data only: no server, account, webview or store.
import { createRoot } from "react-dom/client";

import { ChatCanvasContext } from "../../src/components/chat/ChatCanvasContext";
import { MiniPlayerShell } from "../../src/components/preview/ThreadPreviewMiniPlayer";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const recording = params.get("recording") === "1";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const container = { width: 720, height: 520 };
const frame = { x: 380, y: 40, width: 320, height: 240 };
const source = { kind: "browser", tabId: "tab-1" } as const;
const threadRef = { environmentId: "env-1", threadId: "thread-1" } as never;
const docked: string[] = [];

function App() {
  return (
    <ChatCanvasContext.Provider
      value={{
        container,
        lane: { padding: 16, minChatWidth: 320 },
        layout: { frame } as never,
        previewKey: "browser:tab-1",
        reportPreview: () => {},
        clearPreview: () => {},
        registerTimeline: () => {},
        reportDetailsCard: () => {},
      }}
    >
      <div
        data-case="floating"
        className="relative bg-background text-foreground"
        style={{ width: container.width, height: container.height }}
      >
        <div className="space-y-2 p-4 text-sm text-muted-foreground">
          <p>Chat stand-in. The floating preview sits over it.</p>
        </div>
        <MiniPlayerShell
          threadRef={threadRef}
          miniPlayer={
            {
              source,
              position: { x: frame.x, y: frame.y },
              width: frame.width,
              lastInteraction: "drag",
            } as never
          }
          sourceSize={{ width: 1280, height: 960 }}
          label="Floating browser preview"
          recording={recording}
          onOpenInPanel={() => {
            docked.push("dock");
            document.body.dataset.docked = String(docked.length);
          }}
        >
          {() => (
            <div className="absolute inset-0 z-[48] overflow-hidden rounded-[inherit] bg-white p-4 pt-12 text-sm text-neutral-800">
              <h1 className="text-lg font-semibold">localhost:3000</h1>
              <p>A busy page renders under the toolbar.</p>
            </div>
          )}
        </MiniPlayerShell>
      </div>
    </ChatCanvasContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
