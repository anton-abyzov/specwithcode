import React, { useState } from "react";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../src/rpc/atomRegistry";
import { ProjectWorkspace } from "../../src/components/studio/ProjectWorkspace";
import { ProjectRow } from "../../src/components/studio/shell/SidebarProjectList";
import { useProjectAttention } from "../../src/studio/useProjectAttention";
import {
  attentionFixtureProject,
  attentionShellAtom,
  attentionRemoteAtom,
  setAttentionScenario,
  useThreadShells,
} from "./mocks";
const projects = [attentionFixtureProject];
const group = { projectKey: "atlas", displayName: "Atlas", memberProjects: projects };
function Content() {
  const shells = useThreadShells();
  const attention = useProjectAttention(shells, projects);
  const [scenario, setScenario] = useState("baseline");
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex flex-wrap gap-1 border-b p-2" aria-label="Fixture scenarios">
        {[
          "baseline",
          "coordinator",
          "children",
          "signin",
          "held",
          "operational",
          "review-routing",
          "resolved",
          "archive",
          "delete",
          "pagination",
          "cached",
          "synchronizing",
          "offline",
          "partial",
          "remote-unknown",
          "reconnect",
        ].map((name) => (
          <button
            className="rounded border px-2 py-1 text-xs"
            key={name}
            onClick={() => {
              setScenario(name);
              appAtomRegistry.set(attentionRemoteAtom, {
                workers:
                  name === "remote-unknown"
                    ? [
                        {
                          environmentId: "unpaired",
                          remoteThreadId: "remote-worker",
                          state: "following",
                        },
                      ]
                    : [],
                complete: name !== "partial",
              });
              setAttentionScenario(
                ["partial", "cached", "synchronizing", "offline"].includes(name)
                  ? "coordinator"
                  : name,
              );
              appAtomRegistry.set(attentionShellAtom, {
                ...appAtomRegistry.get(attentionShellAtom),
                status:
                  name === "cached" || name === "offline"
                    ? "cached"
                    : name === "synchronizing"
                      ? "synchronizing"
                      : "live",
              });
            }}
          >
            {name}
          </button>
        ))}
        <output aria-label="Scenario">{scenario}</output>
      </div>
      <div className="min-h-0 flex flex-1 flex-col md:flex-row">
        <aside className="border-r p-2 md:w-56" aria-label="Project sidebar">
          <ProjectRow
            group={group as never}
            displayedProject={attentionFixtureProject}
            archived={false}
            waiting={attention.count}
            attentionLabel={attention.label}
            attentionComplete={attention.complete}
            current
            onOpen={() => {}}
            onArchive={() => {}}
          />
        </aside>
        <div className="min-h-0 min-w-0 flex-1">
          <ProjectWorkspace projectKey="atlas" />
        </div>
      </div>
    </div>
  );
}
export function AttentionFixture() {
  return (
    <AppAtomRegistryProvider>
      <Content />
    </AppAtomRegistryProvider>
  );
}
