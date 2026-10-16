import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectCheckoutMissing } from "../../src/components/settings/ProjectCheckoutMissing";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") || "missing";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const environments = [
  { environmentId: "m1", label: "Anton's MacBook Pro M1Max", connected: view !== "offline" },
  { environmentId: "pro", label: "Anton's MacBook Pro", connected: true },
  { environmentId: "m4", label: "Anton's MacBook M4MAX", connected: true },
];
const group = {
  projectKey: "specweave",
  displayName: "specweave",
  memberProjects: [
    { environmentId: "pro", environmentLabel: "Anton's MacBook Pro", physicalProjectKey: "pro:1" },
    { environmentId: "m4", environmentLabel: "Anton's MacBook M4MAX", physicalProjectKey: "m4:1" },
  ],
};

function Fixture() {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <p className="px-4 pt-4 text-base text-muted-foreground">
        Applying settings for specweave on Anton's MacBook Pro M1Max
      </p>
      <ProjectCheckoutMissing
        group={group}
        environments={environments}
        environmentId="m1"
        checkoutKey={view === "stale" ? "m1:gone" : null}
        onPick={(search) => setPicked(JSON.stringify(search))}
      />
      {picked ? <p data-testid="picked">{picked}</p> : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
