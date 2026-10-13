import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ModelSelection } from "@specweave-studio/contracts";
import { CoordinatorModelPicker } from "../../src/components/studio/shell/CoordinatorModelPicker";
import {
  scenario,
  recoveryScenario,
  completeRefresh,
  recordSelection,
  useFixtureEvents,
} from "./mocks";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark",
);
applyThemePalette(
  "studio-chat",
  document.documentElement.classList.contains("dark") ? "dark" : "light",
);
document.body.style.backgroundColor = document.documentElement.classList.contains("dark")
  ? "#1f1f1f"
  : "#fafafa";
function Fixture() {
  const [selection, setSelection] = useState<ModelSelection | null>(
    scenario === "empty"
      ? null
      : { instanceId: (recoveryScenario ? "codex-work" : "codex") as never, model: "default" },
  );
  const events = useFixtureEvents();
  return (
    <main className="mx-auto min-h-screen max-w-2xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-xl font-semibold">Choose an agent for this project</h1>
        <p className="mt-2 text-sm text-muted-foreground">Remote worker</p>
      </div>
      <div className="flex flex-wrap gap-2 rounded-xl border p-4">
        <CoordinatorModelPicker
          environmentId={"remote-worker" as never}
          value={selection}
          disabled={false}
          saving={scenario === "saving" || scenario === "recovery-saving"}
          onChange={(value) => {
            recordSelection(value);
            setSelection(value);
          }}
          onOpenSettings={() => {
            throw new Error("Wrong project-settings route");
          }}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Isolated UI check. Provider and account data are fixtures.
      </p>
      <output className="block break-all text-xs" data-testid="selection">
        {JSON.stringify(selection)}
      </output>
      <output className="block break-all text-xs" data-testid="navigation" />
      {recoveryScenario ? (
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          onClick={completeRefresh}
        >
          Complete fixture check
        </button>
      ) : null}
      <output className="block break-all text-xs" data-testid="events">
        {JSON.stringify(events)}
      </output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
