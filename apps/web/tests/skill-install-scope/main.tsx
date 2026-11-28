// Settings > Skills for atlas on Studio Mac, around the real install chooser
// and search panel. Query:
//   ?view=project|machine  the project view or the machine (no project) view
//   ?machineDefault=user|project  the machine's default for projects
//   ?projectOwn=user|project      the project's own default
//   ?percy=1   the project is the personal assistant
//   ?older=1   the machine runs a server that cannot take a scope
//   ?hold=1    an install keeps running
//   ?theme=light|dark
import { createRoot } from "react-dom/client";

import {
  SkillInstallScopeChoice,
  useSkillInstallScope,
  useSkillProjectFolder,
} from "~/components/skills/SkillInstallScopeChoice";
import { SkillSearch } from "~/components/skills/SkillSearch";
import { ENVIRONMENT_ID } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const machineView = params.get("view") === "machine";

const scope = {
  environmentId: ENVIRONMENT_ID as never,
  projectId: "project-first" as never,
  ...(machineView ? { userLevel: true } : {}),
};

function Page() {
  const state = useSkillInstallScope(scope);
  const folder = useSkillProjectFolder(scope);
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6 text-sm">
      <header className="space-y-1">
        <p className="text-muted-foreground">Settings / Skills</p>
        <h1 className="text-lg font-medium">
          Set up for {machineView ? "this machine" : "atlas"} on Studio Mac
        </h1>
      </header>
      <div className="space-y-3 rounded-xl border p-4">
        <SkillInstallScopeChoice {...scope} state={state} folder={folder} />
        <SkillSearch {...scope} installScope={state.scope} />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
