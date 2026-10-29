import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ThreadOriginBadge } from "../../src/components/chat/ThreadOriginBadge";
import { MachineReadinessChecklist } from "../../src/components/settings/MachineReadinessChecklist";
import { SavedBackendListRow } from "virtual:outside-agent-machine-row";
import { fixtureEnvironment, environmentId } from "./mocks";
import "./fixture.css";
document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark",
);
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="mx-auto max-w-3xl space-y-8 p-5">
      <h1 className="text-xl">Outside agent controls</h1>
      <section className="flex flex-wrap gap-3">
        <ThreadOriginBadge origin={{ kind: "mcp_client", label: "Claude.ai" }} />
        <ThreadOriginBadge
          origin={{ kind: "fleet_machine", label: "SpecWithCode", machineLabel: "M3" }}
        />
      </section>
      <SavedBackendListRow
        environment={fixtureEnvironment as never}
        removingEnvironmentId={null}
        onSetEnabled={() => {}}
        onRemove={() => {}}
        onAddRoute={() => {}}
      />
      <MachineReadinessChecklist environmentId={environmentId} environmentLabel="Fixture M4" />
    </main>
  </TooltipProvider>,
);
