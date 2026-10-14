import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectEnvironmentImportPreview } from "@specweave-studio/contracts";
import { ProjectEnvironmentImport } from "../../apps/web/src/components/studio/ProjectEnvironmentImport";
import { applyThemePalette } from "../../apps/web/src/themePalette";
import "./fixture.css";

const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
applyThemePalette("studio-chat", theme);
function Fixture() {
  const [attached, setAttached] = useState(false);
  const [busy, setBusy] = useState(false);
  const [calls, setCalls] = useState(0);
  const current = useRef(false);
  const preview = (): ProjectEnvironmentImportPreview => ({
    root: "/Projects/atlas-planning",
    revision: current.current ? 5 : 4,
    fingerprint: "a".repeat(64),
    canApply: true,
    repositories: [
      {
        id: "atlas-web",
        path: "/Projects/atlas-web",
        url: "https://github.com/example/atlas-web",
        status: current.current ? "existing" : "add",
        reason: current.current
          ? "Already attached; keeps its existing ID."
          : "Attach this existing checkout.",
      },
      {
        id: "atlas-api",
        path: "/Projects/atlas-api",
        url: "https://github.com/example/atlas-api",
        status: "existing",
        reason: "Already attached; keeps its existing ID.",
      },
      {
        id: "research",
        path: "/Projects/research",
        url: null,
        status: "blocked",
        reason:
          "No readable origin URL. Use an approved additional folder for this local-only checkout.",
      },
    ],
    environment: {
      additionalFolders: ["/Projects/atlas-web", "/Projects/atlas-api"],
      repositories: [],
    },
  });
  return (
    <main className="project-surface project-workspace mx-auto min-h-screen max-w-3xl p-4 sm:p-8">
      <header className="mb-6">
        <p className="project-eyebrow">Atlas / Environment</p>
        <h1 className="text-xl font-semibold">Connect your existing workspace</h1>
        <p className="project-muted mt-2">
          Synthetic project · Existing native plan · Project ID atlas-product
        </p>
      </header>
      <div className="project-settings-dialog">
        <div className="project-settings-section">
          <ProjectEnvironmentImport
            initialRoot="/Projects/atlas-planning"
            revision={attached ? 5 : 4}
            disabled={busy}
            onBusyChange={setBusy}
            onPreview={async () => preview()}
            onImport={async () => {
              setCalls((n) => n + 1);
              current.current = true;
              setAttached(true);
            }}
          />
        </div>
      </div>
      <section className="mt-6 rounded-lg border p-4" aria-label="Retained project state">
        <h2 className="font-semibold">Project state</h2>
        <p>Project: atlas-product</p>
        <p>Plan: native · 3 tasks retained</p>
        <p>Attached repositories: {attached ? "atlas-api, atlas-web" : "atlas-api"}</p>
        <p>Approved folders: atlas-web, atlas-api</p>
      </section>
      <output hidden data-testid="apply-count">
        {calls}
      </output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
