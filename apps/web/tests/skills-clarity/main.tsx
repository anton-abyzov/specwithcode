import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { ComposerSkillsPopover } from "../../src/components/chat/ComposerSkillsPopover";
import { ProjectSkillsView } from "../../src/components/settings/ProjectSkillsSettings";
import "./fixture.css";
import { advertisedSkills, fixtureProvider, fixtureView } from "./mocks";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

function Fixture() {
  if (fixtureView === "popover")
    return (
      <main className="flex min-h-screen items-end justify-end bg-background p-6 text-foreground">
        <ComposerSkillsPopover
          environmentId={EnvironmentId.make("laptop")}
          projectId={ProjectId.make("fixture")}
          cwd="/work/app"
          threadId={ThreadId.make("thread")}
          provider={fixtureProvider as never}
          machineLabel="Laptop"
          skills={advertisedSkills}
        />
      </main>
    );
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 py-4">
        <h1 className="px-3 text-lg font-semibold sm:px-4">Skills</h1>
        <ProjectSkillsView
          environmentId={EnvironmentId.make("laptop")}
          projectId={ProjectId.make("fixture")}
          folder="/work/app"
          projectIdFor={(environmentId) => ProjectId.make(`fixture-${environmentId}`)}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
