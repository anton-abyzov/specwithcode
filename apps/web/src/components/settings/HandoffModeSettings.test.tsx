import { DEFAULT_HANDOFF_CONFIG, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HandoffModeSettingsView } from "./HandoffModeSettings";

const row = (id: string, title: string, workspaceRoot: string) => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot,
});

const render = (props: Partial<Parameters<typeof HandoffModeSettingsView>[0]>) =>
  renderToStaticMarkup(
    <HandoffModeSettingsView
      snapshot={{
        environmentId: EnvironmentId.make("env-m1"),
        machineLabel: "M1",
        config: DEFAULT_HANDOFF_CONFIG,
        projectModes: {},
        threads: [],
        incoming: [],
        pausedSince: null,
        machineRun: null,
      }}
      destinations={[]}
      projects={[]}
      pending={false}
      error={null}
      onConfig={() => {}}
      onProjectMode={() => {}}
      onHandOffMachine={() => {}}
      {...props}
    />,
  );

describe("Handoff mode project rows", () => {
  it("lists active projects and folds automated and archived ones", () => {
    const html = render({
      projects: [row("app", "EasyChamp", "/Users/me/Projects/sw-easychamp")],
      automatedProjects: [
        row("proof", "EasyChamp handoff test", "/Users/me/.local/share/specweave/fleet/x"),
      ],
      archivedProjects: [row("old", "Old app", "/Users/me/old")],
    });
    expect(html).toContain("Handoff mode for EasyChamp");
    expect(html).not.toContain("EasyChamp handoff test");
    expect(html).not.toContain("Old app");
    expect(html).toContain("Show automated (1)");
    expect(html).toContain("Show archived (1)");
  });

  it("gives each row its full name and folder, and a hint for same-named rows", () => {
    const html = render({
      projects: [
        row("a", "EasyChamp", "/Users/me/Projects/sw-easychamp"),
        row("b", "EasyChamp", "/Volumes/ext/sw-easychamp"),
      ],
    });
    expect(html).toContain('title="EasyChamp\n/Users/me/Projects/sw-easychamp"');
    expect(html).toContain("Projects/sw-easychamp</span>");
    expect(html).toContain("ext/sw-easychamp</span>");
    expect(html).toContain('aria-label="Handoff mode for EasyChamp (ext/sw-easychamp)"');
  });
});
