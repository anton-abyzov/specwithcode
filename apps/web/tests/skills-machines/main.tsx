import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { ProjectSkillsView } from "../../src/components/settings/ProjectSkillsSettings";
import { SettingsScopeSentence } from "../../src/components/settings/SettingsScopeSentence";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

// Settings > Skills at user level on one machine, under the real scope line.
function Fixture() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 py-4">
        <h1 className="px-3 text-lg font-semibold sm:px-4">Skills</h1>
        <SettingsScopeSentence />
        <ProjectSkillsView
          environmentId={EnvironmentId.make("laptop")}
          projectId={ProjectId.make("fixture")}
          folder="~"
          userLevel
          projectIdFor={(environmentId) => ProjectId.make(`fixture-${environmentId}`)}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
