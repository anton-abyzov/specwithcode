import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { ComposerSkillsPopover } from "../../src/components/chat/ComposerSkillsPopover";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
const skills = Array.from({ length: 20 }, (_, i) => ({
  name: i === 19 || i === 0 ? "skill-creator" : i === 1 ? "campaigns" : `skill-${i}`,
  path: `/home/demo/.codex/skills/${i === 19 ? ".system/" : ""}copy-${i}/SKILL.md`,
  scope: i === 18 || i === 19 ? "system" : i > 12 ? "plugin" : "user",
  enabled: i < 13,
  shortDescription: i === 1 ? "Plan a launch" : "Write and review project work",
  description: i === 1 ? "Marketing campaigns for football teams" : "Write and review project work",
}));
function Fixture() {
  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col justify-end p-8 pb-24">
      <h1 className="mb-3 text-xl">Skills in this conversation</h1>
      <div className="flex justify-end rounded-xl border bg-background p-3">
        <ComposerSkillsPopover
          environmentId={"m3" as never}
          projectId={"demo" as never}
          cwd="/work/demo"
          threadId={"thread-demo" as never}
          provider={
            { instanceId: "codex", displayName: "Codex", snapshot: { status: "ready" } } as never
          }
          machineLabel="M3"
          skills={skills}
        />
      </div>
    </main>
  );
}
const rootRoute = createRootRoute({ component: Fixture });
const router = createRouter({ routeTree: rootRoute });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
