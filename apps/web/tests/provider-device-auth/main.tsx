import { createRoot } from "react-dom/client";
import { ProviderAuthenticationSection } from "../../src/components/settings/ProviderAuthenticationSection";
import { ProviderWizardAuthenticationStep } from "../../src/components/settings/ProviderWizardAuthenticationStep";
import type { EnvironmentId, ProviderInstanceId } from "@specweave-studio/contracts";
import { connected, fixtureProvider as provider, readOnly, useRevision } from "./mocks";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
/** The Sign in step of Add provider, for the remote machine m3 (`?view=wizard`). */
function WizardStep() {
  useRevision();
  return (
    <main className="mx-auto grid max-w-3xl gap-3 p-3 sm:p-6">
      <section aria-label="Add provider" className="min-w-0 rounded-xl border border-border">
        <h1 className="px-6 pt-4 text-xl font-semibold">Add provider</h1>
        <p className="px-6 pb-2 text-sm text-muted-foreground">
          Add an account or configure a provider on m3.
        </p>
        <ProviderWizardAuthenticationStep
          environmentId={"m3" as EnvironmentId}
          environmentLabel="m3"
          instanceId={"copilot-work" as ProviderInstanceId}
          onFinish={() => {
            document.body.dataset.wizardFinished = "true";
          }}
        />
      </section>
    </main>
  );
}
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
createRoot(document.getElementById("root")!).render(
  params.get("view") === "wizard" ? <WizardStep /> : <App />,
);
