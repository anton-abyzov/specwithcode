import { createRoot } from "react-dom/client";
import { HandoffShare } from "../../src/components/studio/HandoffShare";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const noop = () => undefined;
createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-background p-4 text-foreground">
    <section className="mx-auto max-w-xl rounded-xl border p-5 shadow-sm">
      <h1 className="mb-4 text-lg font-semibold">Hand off OlySense</h1>
      <HandoffShare
        project={
          {
            environmentId: "m3",
            id: "fixture",
            title: "OlySense",
            workspaceRoot: "/work/olysense",
            repositoryIdentity: null,
          } as never
        }
        sourceLabel="M3"
        machines={[{ value: "m1", label: "M1", tone: "ready" }]}
        machine={"m1" as never}
        machineLabel="M1"
        linked={false}
        joined={false}
        uncommittedFiles={57}
        loading={false}
        canClone
        onMachineChange={noop}
        onMove={noop}
        onCopyInstead={noop}
        onNeedsFolderChoice={noop}
        onBusyChange={noop}
        onClose={noop}
        onPrepareRepositories={() => {
          document.getElementById("result")!.textContent = "Mixed Git and local-file review opened";
        }}
      />
      <p id="result" role="status" />
    </section>
  </main>,
);
