// Headless fixture: the production Settings › Agents page over one synthetic machine, so the
// Claude workflows section and its "Ultracode by default" row render as shipped.
// ?mode=automatic seeds a machine whose stored workflow mode is the retired Automatic.
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { AgentInstructionsSettings } from "~/components/settings/AgentInstructionsSettings";
import { ToastProvider } from "~/components/ui/toast";
import { fixtureState } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

fixtureState.set({
  ...DEFAULT_SERVER_SETTINGS,
  claudeWorkflowMode: params.get("mode") === "automatic" ? "automatic" : "on-request",
});
// The verifier reads what the rows saved.
Object.assign(window, { fixtureState });

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <AgentInstructionsSettings />
    </div>
  </ToastProvider>,
);
