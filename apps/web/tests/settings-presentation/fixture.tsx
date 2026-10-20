import React from "react";
import { createRoot } from "react-dom/client";
import { ProjectWorkspaceSettings } from "../../src/components/studio/ProjectWorkspaceSettings";
import { ProjectLocation } from "../../src/components/studio/ProjectLocation";
import { SettingsRow, SettingsSection } from "../../src/components/settings/settingsLayout";
import { project, useEnvironmentQuery } from "./mocks";
const path =
  "/Users/developer/.local/share/specweave/fleet/handoff-proof-20261013/" +
  "copilot116-echo-root-m3-4e1b616b097a49d4b8baf6a3043d65a8/".repeat(5) +
  "acpRegistry_github_copilot-fixture";
project.title =
  "116 Copilot echo verification acpRegistry_github_copilot " + "long-project-name".repeat(8);
project.workspaceRoot = path;
const snapshot = useEnvironmentQuery({ kind: "read" }).data;
snapshot.settings.environment.additionalFolders = [
  path + "/research",
  "C:\\Projects\\" + "deep-folder-".repeat(35),
];
snapshot.settings.environment.repositories = [
  {
    id: "repo-one",
    url: "https://github.com/example/" + "long-repository-name".repeat(15),
    localPath: path,
  },
];
const connectionState = useEnvironmentQuery({ kind: "connections" }).data;
connectionState.connections.push({
  id: "long-connection",
  name: "Repository-tool-".repeat(15),
  command: "/usr/local/bin/tool",
  args: [],
  envKeys: [],
  allowedTools: [],
  tools: [],
  revision: 1,
  status: "saved",
});
const shared = new URLSearchParams(location.search).has("shared");
createRoot(document.getElementById("root")!).render(
  shared ? (
    <main style={{ maxWidth: 900, margin: "24px auto", padding: 16 }}>
      <SettingsSection
        title="Project folders"
        description="Settings stay readable with long paths and names."
      >
        <SettingsRow
          title={"Project-".repeat(30)}
          description={<ProjectLocation path={path} />}
          control={<button className="project-control">Choose folder</button>}
        />
        <SettingsRow
          title="Repository"
          description={snapshot.settings.environment.repositories[0].url}
          control={<input aria-label="Repository value" defaultValue={path} />}
        />
      </SettingsSection>
    </main>
  ) : (
    <ProjectWorkspaceSettings
      project={project}
      projectKey="atlas"
      snapshot={snapshot}
      initialTab="environment"
      canOperate
      onClose={() => {
        document.body.dataset.closed = "true";
      }}
      onSaved={() => {}}
      onDeleted={() => {}}
      onOpenThread={() => {}}
    />
  ),
);
