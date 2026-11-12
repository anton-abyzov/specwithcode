import { createRoot } from "react-dom/client";
import { ComposerVoiceMenu } from "../../src/components/studio/ComposerVoiceMenu";
import { OrchestratorSwitcher } from "../../src/components/studio/OrchestratorSwitcher";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import "./fixture.css";
const dictation = {
  available: true,
  active: false,
  phase: "idle",
  start: () => {},
  stop: () => {},
  consentOpen: false,
} as any;
const call = {
  available: true,
  active: false,
  unavailableReason: null,
  start: () => {},
  end: () => {},
  consentOpen: false,
} as any;
function App() {
  return (
    <TooltipProvider>
      <main style={{ padding: 24, maxWidth: 850, margin: "60px auto" }}>
        <h1 className="text-xl font-semibold mb-6">Project coordinator</h1>
        <section className="sws-composer rounded-xl border border-border p-3">
          <textarea
            aria-label="Message"
            placeholder="What would you like to work on?"
            className="w-full h-28 resize-none bg-transparent p-2"
          />
          <div className="sws-composer-foot">
            <span className="sws-composer-meta">
              <button aria-label="Attach files" className="p-2">
                +
              </button>
              <OrchestratorSwitcher
                label="Build machine"
                identity={{ color: "blue" } as any}
                connected
                statusDetail=""
                current="build:p"
                copies={[
                  {
                    key: "build:p",
                    machine: "Build machine",
                    folder: "/workspace/project",
                    role: "coordinator",
                    canStart: false,
                  },
                  {
                    key: "laptop:p",
                    machine: "Laptop",
                    folder: "/workspace/project",
                    role: "workers",
                    canStart: true,
                  },
                ]}
                unknown={[]}
                savedMachineMissing={false}
                onView={() => {}}
                onMove={() => {}}
                onStart={null}
                onAllowWorkers={null}
                onMoveElsewhere={() => {}}
              />
              <ComposerVoiceMenu dictation={dictation} call={call} />
              <span className="text-xs text-muted-foreground">Working</span>
            </span>
            <button className="ml-auto rounded-md bg-primary text-primary-foreground px-3 py-1">
              Send
            </button>
          </div>
        </section>
        <p className="text-xs text-muted-foreground mt-4">
          Component fixture · fictional machines · no live microphone or migration
        </p>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
