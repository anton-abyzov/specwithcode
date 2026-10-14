import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MachineHandoffDialog } from "../../src/components/studio/MachineHandoffDialog";
import { HandoffFolderPicker } from "../../src/components/studio/HandoffFolderPicker";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
function Fixture() {
  const [selected, setSelected] = useState("m1:easychamp");
  const [phase, setPhase] = useState<"choose" | "review">("choose");
  const [consent, setConsent] = useState(false);
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
        onSelect={setSelected}
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
              machines={[
                { id: "m1" as never, label: "MacBook Pro M1", unavailable: null },
                { id: "m3" as never, label: "MacBook Pro M3", unavailable: null },
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
