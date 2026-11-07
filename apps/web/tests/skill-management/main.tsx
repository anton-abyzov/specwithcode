import { AuthoringFixture } from "./AuthoringFixture";
import { FleetPushPanel } from "../../src/components/settings/ProjectSkillFleetPush";
import { SkillDetailPanel } from "../../src/components/skills/SkillDetailPanel";
import { setFixtureRow } from "./mocks";
import { createRoot } from "react-dom/client";
import { SkillDetails } from "../../src/components/settings/ProjectSkillsSettings";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const row = {
  name: "image-workflow",
  description:
    "Create and edit visual assets using `image-v2`.\n\nUse when preparing product illustrations, editorial images or social cards. Review [the guide](https://example.com/guide) before publishing.\n\nChoose the intended format and describe the audience. Keep brand references consistent. Include a clear subject and lighting direction, then review the generated result before sharing.",
  status: "ok",
  attention: false,
  issues: [],
  doctor: [],
  drift: "unlocked",
  lock: null,
  scopes: ["user"],
  copies: 2,
  divergent: true,
  path: "/home/demo/.agents/skills/image-workflow/SKILL.md",
  providers: ["Claude", "Codex", "Copilot", "Gemini"].map((label, i) => ({
    instanceId: ["claudeAgent", "codex", "copilot", "gemini"][i],
    driver: i === 0 ? "claudeAgent" : i === 1 ? "codex" : "acpRegistry",
    label,
    path:
      i === 0
        ? "/home/demo/.claude/skills/image-workflow/SKILL.md"
        : "/home/demo/.agents/skills/image-workflow/SKILL.md",
    scope: "user",
    enabled: true,
    fileVersion: i === 0 ? "1.2.0" : "1.3.0",
  })),
};
setFixtureRow(row);
function Fixture() {
  if (params.get("case") === "authoring") return <AuthoringFixture />;
  if (params.get("case") === "fleet")
    return (
      <main className="flex min-h-screen justify-end bg-muted/30 text-foreground">
        <aside className="w-full max-w-lg space-y-6 border-l bg-background p-6">
          <header>
            <h1 className="text-xl font-semibold">Install on all</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Review destinations before installing this version.
            </p>
          </header>
          <FleetPushPanel />
        </aside>
      </main>
    );
  return (
    <main className="flex min-h-screen justify-end bg-muted/30 text-foreground">
      <aside className="flex min-h-screen w-full max-w-2xl flex-col border-l bg-background">
        <header className="p-6">
          <h1 className="text-2xl font-semibold">{row.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">Read, compare and manage this skill.</p>
        </header>
        <SkillDetailPanel
          row={row as never}
          machineLabel="Laptop"
          initialView={params.get("view") === "compare" ? "compare" : "overview"}
          onEdit={() => {}}
          onChanged={() => {}}
        >
          <SkillDetails row={row as never} entries={new Map()} />
        </SkillDetailPanel>
      </aside>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
