import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@specweave-studio/contracts";
import { IncomingWorkerSetup } from "../../src/components/settings/IncomingWorkerSetup";
import "./fixture.css";
const theme = new URLSearchParams(location.search).get("theme") ?? "light";
document.documentElement.classList.toggle("dark", theme === "dark");
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-3xl p-5">
    <p className="mb-6 text-xs text-muted-foreground">Settings / Machines / M4 Max</p>
    <h1 className="mb-2 text-xl font-semibold">Who can run work here</h1>
    <p className="mb-5 text-sm text-muted-foreground">No other machine can start work here.</p>
    <section className="overflow-hidden rounded-lg border border-border">
      <IncomingWorkerSetup
        environmentId={EnvironmentId.make("m4")}
        snapshot={{ grants: [], projects: [], accounts: [] }}
        onGranted={() => {}}
      />
    </section>
  </main>,
);
