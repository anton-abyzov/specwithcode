// First-run setup's Machine basics block, over fixture answers. Query:
//   ?view=ready|no-gh|missing|installing|linux
//   ?os=darwin|windows|linux
//   ?theme=light|dark
//   ?open=1                the optional GitHub CLI line opened
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type ExecutionEnvironmentPlatformOs } from "@specweave-studio/contracts";
import { AtomRegistry } from "effect/reactivity";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";

import { MachineBasics } from "../../src/components/onboarding/MachineBasics";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const os = (params.get("os") ?? "darwin") as ExecutionEnvironmentPlatformOs;

function Fixture() {
  useEffect(() => {
    if (params.get("open") !== "1") return;
    const timer = setInterval(() => {
      const details = document.querySelector<HTMLDetailsElement>("[data-machine-basics-optional]");
      if (details) {
        details.open = true;
        clearInterval(timer);
      }
    }, 20);
    return () => clearInterval(timer);
  }, []);
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8" data-fixture>
      <h2 className="font-semibold text-lg">Agents</h2>
      <p className="text-muted-foreground text-sm">
        Pick the agents this machine runs. Machine basics are checked below.
      </p>
      <MachineBasics
        environmentId={EnvironmentId.make("env-fixture")}
        os={os}
        readOnly={false}
        fallback={<p>older server</p>}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <RegistryContext.Provider value={AtomRegistry.make()}>
    <Fixture />
  </RegistryContext.Provider>,
);
