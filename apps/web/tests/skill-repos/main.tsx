import { createRoot } from "react-dom/client";
import { SkillUpdateCenter } from "../../src/components/skills/SkillUpdateCenter";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-muted/30 text-foreground">
    <div className="mx-auto w-full max-w-3xl space-y-4 bg-background p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">Skills</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find, install and update skills on this machine.
        </p>
      </header>
      <SkillUpdateCenter
        environmentId={"local" as never}
        projectId={"project" as never}
        cwd="/home/demo/app"
      />
    </div>
  </main>,
);
