import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ModelSelection } from "@specweave-studio/contracts";
import { CoordinatorModelPicker } from "../../src/components/studio/shell/CoordinatorModelPicker";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { applyThemePalette } from "../../src/themePalette";
import { scenario, recordSelection, recordSwitchBack, useFixtureEvents } from "./mocks";
import "./fixture.css";

// `?state=fallback` the reported case; `noback` no way back from here (offline or
// read-only); `switching` a switch back in flight; `home` no fallback runs.
const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const saved = { instanceId: "codex", model: "gpt-6.1-sol" } as ModelSelection;
const devin = { instanceId: "devin_work", model: "gpt-6.1-sol" } as ModelSelection;

function Fixture() {
  const [selection, setSelection] = useState<ModelSelection | null>(saved);
  const [onFallback, setOnFallback] = useState(scenario !== "home");
  const events = useFixtureEvents();
  return (
    <TooltipProvider>
      <main className="mx-auto min-h-screen max-w-2xl space-y-4 p-6">
        <h1 className="text-lg font-semibold">EasyChamp coordinator</h1>
        <div className="flex flex-wrap gap-2 rounded-xl border p-3">
          <CoordinatorModelPicker
            environmentId={"m4" as never}
            value={selection}
            running={
              onFallback
                ? {
                    value: devin,
                    returnsTo: null,
                    offPick: true,
                    reason: "Codex weekly at 96% used.",
                    onSwitchBack:
                      scenario === "noback"
                        ? null
                        : () => {
                            recordSwitchBack();
                            setOnFallback(false);
                          },
                    switching: scenario === "switching",
                  }
                : null
            }
            disabled={false}
            saving={false}
            onChange={(value) => {
              recordSelection(value);
              setSelection(value);
            }}
            onOpenSettings={() => {}}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Isolated UI check. Provider and account data are fixtures.
        </p>
        <output className="block text-xs" data-testid="events">
          {JSON.stringify({ ...events, onFallback })}
        </output>
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
