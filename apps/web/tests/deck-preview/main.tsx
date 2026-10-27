/* Isolated fixture: the production Library viewer in the app's viewer overlay, on a PowerPoint deck. */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import { ViewerOverlayHost } from "../../src/components/ViewerOverlayHost";
import { LibraryFileViewer } from "../../src/components/studio/shell/LibraryFileViewer";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { fixture } from "./stubs/fixture";
import "./fixture.css";

// ?theme=dark&deck=ok|corrupt|old-server&file=deck|key
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
fixture.deck = (params.get("deck") as typeof fixture.deck | null) ?? "ok";

const ROOT = "/Users/you/.specwithcode/m4/evidence/installed-design-acceptance-20261026";
const FILES = [
  { path: "exports/design-export-check.png", name: "design-export-check.png" },
  { path: "exports/installed-1.0.92-deck.pdf", name: "installed-1.0.92-deck.pdf" },
  { path: "exports/launch-talk.key", name: "launch-talk.key" },
  { path: "exports/installed-1.0.92-deck.pptx", name: "installed-1.0.92-deck.pptx" },
];

function Root() {
  const initial = params.get("file") === "key" ? FILES[2]!.path : FILES[3]!.path;
  const [path, setPath] = useState<string | null>(initial);
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <div className="flex h-screen bg-background p-6 text-foreground">
          <h1 className="text-xl">Library</h1>
        </div>
        {path !== null ? (
          <LibraryFileViewer
            environmentId={"fixture-host" as EnvironmentId}
            workspaceRoot={ROOT}
            files={FILES.map((file) => ({ ...file, modifiedAt: "2026-10-26T10:52:00.000Z" }))}
            path={path}
            onPath={setPath}
            onClose={() => setPath(null)}
          />
        ) : null}
        <ViewerOverlayHost />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: Root }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
