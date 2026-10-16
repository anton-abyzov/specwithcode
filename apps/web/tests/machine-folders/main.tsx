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
  const [machine, setMachine] = useState<string | null>("m3");
  const [remembered, setRemembered] = useState(false);
  const [dirty, setDirty] = useState(true);
  const [destinations, setDestinations] = useState([
    {
      key: "m1:easychamp",
      environmentId: "m1",
      label: "MacBook Pro M1",
      folder: "/Users/you/Projects/sw-easychamp",
      unavailable: null,
    },
    {
      key: "m3:easychamp",
      environmentId: "m3",
      label: "MacBook Pro M3",
      folder: "/Users/you/Projects/sw-easychamp",
      unavailable: null,
    },
  ]);
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <h1>EasyChamp</h1>
      <MachineHandoffDialog
        open
        onOpenChange={() => {}}
        sourceLabel="MacBook Pro M4"
        projectTitle="EasyChamp"
        destinations={destinations}
        selected={selected}
        onSelect={(key) => {
          setSelected(key);
          setMachine(null);
        }}
        sourceChanges={{
          state: dirty ? "dirty" : "clean",
          fileCount: dirty ? 2 : 0,
          committing: false,
          error: null,
          onCommit: dirty ? () => setDirty(false) : null,
        }}
        rememberMachine={
          machine || selected
            ? {
                label: (machine ?? selected).startsWith("m1") ? "MacBook Pro M1" : "MacBook Pro M3",
                checked: remembered,
                onChange: setRemembered,
              }
            : null
        }
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
              title="EasyChamp"
              key={machine ?? ""}
              machine={machine as never}
              onMachineChange={(value) => {
                setMachine(value);
                if (value) setSelected("");
              }}
              defaultOpen
              sourceFolder="/Users/anton/Projects/sw-easychamp"
              machines={[
                {
                  id: "m1" as never,
                  label: "MacBook Pro M1",
                  online: true,
                  unavailable: null,
                  workersAllowed: false,
                  hasProjectFolder: true,
                  lastOnlineAt: null,
                },
                {
                  id: "m3" as never,
                  label: "MacBook Pro M3",
                  online: true,
                  unavailable: null,
                  workersAllowed: true,
                  hasProjectFolder: false,
                  lastOnlineAt: null,
                },
                {
                  id: "m2" as never,
                  label: "Mac mini",
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
                    label: environmentId === "m1" ? "MacBook Pro M1" : "MacBook Pro M3",
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
