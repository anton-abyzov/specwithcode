// A saved report in the real artifact viewer (`/report-doc.html`): frontmatter,
// a wide table, code, a Mermaid fence and a link to another Markdown file.
// `?theme=dark` for dark. No server, account or network.
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { fileLinkMetaAtPath } from "../../src/markdown-links";
import { fileArtifact } from "../../src/threadArtifacts";
import { ArtifactViewer } from "../../src/components/chat/ThreadArtifacts";
import { ViewerOverlayHost } from "../../src/components/ViewerOverlayHost";
import { useViewerOverlayStore } from "../../src/viewerOverlayStore";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { REPORT_DOC_PATH } from "./reportDocFixture";
import "./fixture.css";

const search = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", search.get("theme") === "dark");

const threadRef = { environmentId: "fixture", threadId: "fixture-thread" } as never;
const ROOT = "/Users/fixture/work/atlas";
const ARTIFACTS = [fileArtifact(fileLinkMetaAtPath({}, REPORT_DOC_PATH), "message-report")];

function Root() {
  const [open, setOpen] = useState(true);
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <div className="flex h-screen min-h-0 bg-background text-foreground">
          <main className="flex min-w-0 flex-1 flex-col p-6 text-sm">
            <button type="button" data-fixture-open="" onClick={() => setOpen(true)}>
              Open the report
            </button>
          </main>
        </div>
        {open ? (
          <ArtifactViewer
            threadRef={threadRef}
            cwd={ROOT}
            artifacts={ARTIFACTS}
            index={0}
            onIndex={() => {}}
            onClose={() => setOpen(false)}
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
Object.assign(window, {
  fixtureState: () => ({
    overlay: useViewerOverlayStore.getState().active?.title ?? null,
    linked: useViewerOverlayStore.getState().linked !== null,
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
