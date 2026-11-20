import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MachineHandoffDialog } from "../../src/components/studio/MachineHandoffDialog";
import { HandoffFolderPicker } from "../../src/components/studio/HandoffFolderPicker";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
function Fixture() {
  const [selected, setSelected] = useState("");
  const [phase, setPhase] = useState<"choose" | "review">("choose");
  const [consent, setConsent] = useState(false);
  const [machine, setMachine] = useState<string | null>("kioskD");
  const [dirty, setDirty] = useState(true);
  const [destinations, setDestinations] = useState([
    {
      key: "deskB:atlas",
      environmentId: "deskB",
      label: "Desk B",
      folder: "/Users/you/Projects/atlas",
      unavailable: null,
    },
  ]);
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <h1>Atlas</h1>
      <MachineHandoffDialog
        open
        onOpenChange={() => {}}
        sourceLabel="Laptop E"
        projectTitle="Atlas"
        destinations={destinations}
        selected={selected}
        onSelect={setSelected}
        machines={[
          { value: "deskB", label: "Desk B", tone: "ready" },
          { value: "kioskD", label: "Kiosk D", tone: "ready" },
          { value: "hubC", label: "Hub C", tone: "off", reason: "Offline", disabled: true },
        ]}
        machine={machine}
        onMachineChange={(value) => {
          setMachine(value);
          setSelected(destinations.find((item) => item.environmentId === value)?.key ?? "");
        }}
        method="folder"
        onMethodChange={() => {}}
        sourceChanges={{
          state: dirty ? "dirty" : "clean",
          fileCount: dirty ? 2 : 0,
          committing: false,
          error: null,
          onCommit: dirty ? () => setDirty(false) : null,
        }}
        phase={phase}
        error={null}
        consent={consent}
        onConsent={setConsent}
        onReview={() => setPhase("review")}
        onContinue={() => {}}
        onOpenDestination={() => {}}
        preview={
          phase === "review"
            ? { repositories: [{ relativePath: ".", head: "a".repeat(40) }], messageCount: 18 }
            : null
        }
        folderPicker={
          phase === "choose" ? (
            <HandoffFolderPicker
              title="Atlas"
              key={machine ?? ""}
              machine={machine as never}
              sourceFolder="/Users/sam/Projects/atlas"
              machines={[
                {
                  id: "deskB" as never,
                  label: "Desk B",
                  online: true,
                  unavailable: null,
                  workersAllowed: false,
                  hasProjectFolder: true,
                  lastOnlineAt: null,
                },
                {
                  id: "kioskD" as never,
                  label: "Kiosk D",
                  online: true,
                  unavailable: null,
                  workersAllowed: true,
                  hasProjectFolder: false,
                  lastOnlineAt: null,
                },
                {
                  id: "hubC" as never,
                  label: "Hub C",
                  online: false,
                  unavailable: "Connect first",
                  workersAllowed: false,
                  hasProjectFolder: false,
                  lastOnlineAt: null,
                },
              ]}
              onSaved={(environmentId, projectId, path) => {
                const key = `${environmentId}:${projectId}`;
                setDestinations((items) => [
                  ...items,
                  {
                    key,
                    environmentId,
                    label: environmentId === "deskB" ? "Desk B" : "Kiosk D",
                    folder: path,
                    unavailable: null,
                  },
                ]);
                setSelected(key);
              }}
            />
          ) : undefined
        }
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
