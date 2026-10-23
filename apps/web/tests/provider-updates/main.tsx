import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@specweave-studio/contracts";
import { ProviderUpdatesAction } from "../../src/components/ProviderUpdatesAction";
import "./fixture.css";
document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark",
);
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <main className="p-8">
      <button onClick={() => setOpen(true)}>Update selected Codex</button>
      {open && (
        <ProviderUpdatesAction
          target={{
            environmentId: EnvironmentId.make("fixture-0"),
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
          }}
          open
          onOpenChange={setOpen}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
