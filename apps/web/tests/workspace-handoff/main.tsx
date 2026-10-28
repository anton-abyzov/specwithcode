// Synthetic data only; no project, account, filesystem access or provider.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@specweave-studio/contracts";
import { HandoffWorkspaceSummary } from "../../src/components/studio/HandoffWorkspaceSummary";
import { HandoffCopySetup } from "../../src/components/studio/HandoffCopySetup";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";
const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
function Fixture() {
  const [folder, setFolder] = useState("D:\\Projects\\football-platform");
  const [mode, setMode] = useState<"copy-only" | "copy-and-move">("copy-only");
  const [choose, setChoose] = useState(false);
  return (
    <main className="mx-auto max-w-xl space-y-4 p-4">
      <h1 className="text-lg font-semibold">Continue on another machine</h1>
      <HandoffWorkspaceSummary
        transferContext={mode === "copy-and-move"}
        destinationWorktreeStorage={"D:\\SpecWithCode\\worktrees"}
        source={{
          projectFolder: "/Users/example/Projects/football-platform",
          repository: "/Users/example/Projects/football-platform/repositories/api",
          checkout: "/Users/example/.specwithcode/worktrees/api/task-1108",
          mode: "worktree",
          branch: "feature/workspace-lifecycle",
        }}
        copyRoot="/Users/example/Projects/football-platform"
        destinationFolder={`${folder}\\repositories\\api`}
      />
      <HandoffCopySetup
        machines={[
          {
            id: EnvironmentId.make("fixture-target"),
            label: "Windows workstation",
            unavailable: null,
          },
        ]}
        machine={EnvironmentId.make("fixture-target")}
        onMachineChange={() => {}}
        targetLabel="Windows workstation"
        sourceLabel="MacBook"
        folder={folder}
        onFolderChange={setFolder}
        findingHome={false}
        projectRelativePath="repositories/api"
        mode={mode}
        onModeChange={setMode}
        canMove={true}
        chooseFirst={choose}
        onChooseFirstChange={setChoose}
        disabled={false}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
