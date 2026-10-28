import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ThreadEnvMode,
} from "@specweave-studio/contracts";
import { WorktreesDirectoryRow } from "../../src/components/settings/StorageSettings";
import { WorkspaceModeControl } from "../../src/components/chat/WorkspaceModeControl";
import { FixtureContext } from "./mocks";
import "./fixture.css";
const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.get("theme") === "dark");
function Fixture() {
  const [settings, setSettings] = useState<ServerSettings>({
    ...DEFAULT_SERVER_SETTINGS,
    worktreesDirectory: query.get("legacy") ? "/Volumes/Workspace/worktrees" : "",
  });
  const [mode, setMode] = useState<ThreadEnvMode>("worktree");
  return (
    <FixtureContext.Provider
      value={{
        settings,
        update: (patch) => setSettings((previous) => ({ ...previous, ...patch }) as ServerSettings),
        multi: query.has("multi"),
      }}
    >
      <main className="mx-auto max-w-4xl p-5 sm:p-10">
        <h1 className="text-2xl font-semibold">Workspace and storage</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Synthetic fixture using the real storage and chat controls.
        </p>
        <section className="mt-7 border-y border-border py-5">
          <h2 className="mb-3 font-medium">New chat</h2>
          <WorkspaceModeControl mode={mode} onChange={setMode} />
          <p className="mt-2 text-sm text-muted-foreground">
            {mode === "worktree"
              ? "A separate Git checkout keeps this chat isolated."
              : "Work directly in the project’s current checkout."}
          </p>
        </section>
        <section className="py-5">
          <h2 className="font-medium">Project folder</h2>
          <p className="break-all text-sm text-muted-foreground">/Users/example/projects/river</p>
        </section>
        <WorktreesDirectoryRow />
        <output className="sr-only" data-testid="settings">
          {JSON.stringify(settings)}
        </output>
      </main>
    </FixtureContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
