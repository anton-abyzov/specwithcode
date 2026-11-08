import {
  evaluateWorkflow,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import { WorkflowCapabilities } from "../../src/components/settings/WorkflowCapabilities";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionsLibrarySettings } from "../../src/components/settings/ConnectionsLibrarySettings";
import { setFixture, setProject } from "./mocks";
import "./fixture.css";
function WorkflowFixture() {
  const now = Date.parse("2026-10-28T04:00:00Z");
  const workflow = evaluateWorkflow({
    scope: {
      environmentId: "Linux worker",
      instanceId: "codex-personal",
      workspaceRoot: "/home/example/project",
      sessionId: "native-session-3",
      providerThreadId: "native-thread-3",
      nativeThreadId: "codex-native-3",
      threadId: "match-report-thread",
    },
    declaration: {
      state: "declared",
      requires: { tools: ["mcp__reports__read_match"], binaries: ["ffmpeg"], platforms: ["linux"] },
    },
    enabled: true,
    discoveredAt: new Date(now).toISOString(),
    now,
    platform: "linux",
    binaries: new Map([["ffmpeg", "missing"]]),
  });
  return (
    <main className="mx-auto max-w-3xl space-y-5 p-4 text-sm">
      <h1 className="text-xl font-medium">Match report workflow</h1>
      <WorkflowCapabilities
        presence={{
          label: "Codex",
          instanceId: ProviderInstanceId.make("codex-personal"),
          driver: ProviderDriverKind.make("codex"),
          path: "/example/SKILL.md",
          scope: "project",
          enabled: true,
          workflow,
        }}
      />
    </main>
  );
}
function App() {
  const [project, updateProject] = useState(false);
  return (
    <>
      <div
        className="mx-auto flex max-w-4xl flex-wrap gap-4 p-4 text-sm"
        aria-label="Test controls"
      >
        <label>
          Fixture state{" "}
          <select aria-label="Fixture state" onChange={(e) => setFixture(e.target.value)}>
            {[
              "ready",
              "offline",
              "denied",
              "error",
              "loading",
              "empty",
              "invalid",
              "folders",
              "grid",
            ].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={project}
            onChange={(e) => {
              updateProject(e.target.checked);
              setProject(e.target.checked);
            }}
          />{" "}
          Project scope
        </label>
      </div>
      <ConnectionsLibrarySettings />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  location.search.includes("workflow") ? <WorkflowFixture /> : <App />,
);
