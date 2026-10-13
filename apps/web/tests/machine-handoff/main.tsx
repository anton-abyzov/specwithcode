import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MachineHandoffDialog } from "../../src/components/studio/MachineHandoffDialog";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
function Fixture() {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState("m1");
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<"choose" | "review" | "complete">("choose");
  const [opened, setOpened] = useState(false);
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <h1 className="text-lg font-medium">EasyChamp</h1>
      <p className="text-sm text-muted-foreground">Machine handoff interaction preview</p>
      <button onClick={() => setOpen(true)}>Handoff</button>
      {opened && <p role="status">Destination coordinator opened</p>}
      <MachineHandoffDialog
        open={open}
        onOpenChange={setOpen}
        sourceLabel="MacBook Pro M4"
        projectTitle="EasyChamp"
        selected={selected}
        onSelect={setSelected}
        destinations={[
          {
            key: "m1",
            label: "Mac mini M1",
            folder: "/Users/you/Projects/sw-easychamp-fleet",
            unavailable: null,
          },
          {
            key: "m3",
            label: "MacBook Air M3",
            folder: "/Users/you/Projects/sw-easychamp",
            unavailable: null,
          },
          {
            key: "offline",
            label: "Offline machine",
            folder: "/Projects/sw-easychamp",
            unavailable: "Connect this machine first.",
          },
        ]}
        preview={
          phase === "choose"
            ? null
            : {
                messageCount: 18,
                repositories: [
                  { relativePath: ".", head: "a".repeat(40) },
                  {
                    relativePath: "repositories/anton-abyzov/easychamp-football",
                    head: "b".repeat(40),
                  },
                  { relativePath: "repositories/anton-abyzov/easychamp-api", head: "c".repeat(40) },
                ],
              }
        }
        phase={phase}
        consent={consent}
        onConsent={setConsent}
        error={
          params.has("error")
            ? "The destination checkout has local changes. Commit or save them, then retry this handoff."
            : null
        }
        onReview={() => setPhase("review")}
        onContinue={() => setPhase("complete")}
        onOpenDestination={() => {
          setOpened(true);
          setOpen(false);
        }}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
