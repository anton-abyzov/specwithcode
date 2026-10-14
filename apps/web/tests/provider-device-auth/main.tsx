import { createRoot } from "react-dom/client";
import { ProviderAuthenticationSection } from "../../src/components/settings/ProviderAuthenticationSection";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
} from "@specweave-studio/contracts";
import { connected, readOnly, useRevision } from "./mocks";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const provider = (environmentId: string): ServerProvider => ({
  instanceId: "copilot-work" as ProviderInstanceId,
  driver: "acpRegistry" as never,
  displayName: "GitHub Copilot",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "unknown" },
  setup: { canAuthenticate: true, canInstall: false },
  checkedAt: "2026-10-14T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});
function App() {
  useRevision();
  return (
    <main className="mx-auto grid max-w-4xl gap-6 p-3 sm:p-6">
      <h1 className="text-xl font-semibold">Sign in on your connected machines</h1>
      {connected ? (
        ["m1", "m3"].map((environmentId) => (
          <section
            key={environmentId}
            aria-label={`${environmentId.toUpperCase()} provider`}
            className="min-w-0 rounded-xl border border-border pb-3"
          >
            <h2 className="px-4 pt-3 font-medium">{environmentId.toUpperCase()}</h2>
            <ProviderAuthenticationSection
              environmentId={environmentId as EnvironmentId}
              environmentLabel={environmentId.toUpperCase()}
              instanceId={"copilot-work" as ProviderInstanceId}
              provider={provider(environmentId)}
              readOnly={readOnly}
            />
          </section>
        ))
      ) : (
        <p>Disconnected fixture panels</p>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
