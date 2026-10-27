import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { HtmlRenderFrame } from "../../src/components/chat/HtmlRenderFrame";
import { ViewerOverlayHost } from "../../src/components/ViewerOverlayHost";
import { useViewerOverlayStore } from "../../src/viewerOverlayStore";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import "./fixture.css";
window.addEventListener("message", (event) => {
  if (event.source === document.querySelector("iframe")?.contentWindow)
    Object.assign(window, event.data);
});
const search = new URLSearchParams(location.search);
const dark = search.get("theme") === "dark";
// `&evidence`: the reply's own thread and folder, which evidence links open in.
const evidence = search.has("evidence");
// `&visual`: a show_visual diagram instead of a report.
const visual = search.has("visual");
document.documentElement.classList.toggle("dark", dark);
function Root() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <main style={{ maxWidth: 760, margin: "64px auto", padding: 20 }}>
          <p style={{ marginBottom: 24, color: "var(--muted-foreground)" }}>
            Season setup · Conversation
          </p>
          <HtmlRenderFrame
            environmentId={"fixture" as never}
            htmlRender={
              (visual
                ? {
                    attachmentId: "visual",
                    title: "agent_visual_flow",
                    height: 2000,
                    kind: "visual",
                  }
                : {
                    attachmentId: "example",
                    title: "Season setup and registration",
                    height: 1500,
                    width: 728,
                  }) as never
            }
            {...(evidence
              ? {
                  threadRef: { environmentId: "fixture", threadId: "fixture-thread" } as never,
                  cwd: "/Users/fixture/work/atlas",
                }
              : {})}
          />
          <p style={{ marginTop: 24 }}>The conversation continues here.</p>
          <textarea
            aria-label="Message draft"
            placeholder="Ask a follow-up"
            style={{
              width: "100%",
              marginTop: 20,
              padding: 16,
              border: "1px solid var(--border)",
              borderRadius: 12,
            }}
          />
        </main>
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
    collapsed: useViewerOverlayStore.getState().threadCollapsed,
    linked: (() => {
      const linked = useViewerOverlayStore.getState().linked;
      return linked?.kind === "file"
        ? {
            path: linked.file.path,
            line: linked.file.line ?? null,
            environmentId: linked.file.threadRef.environmentId,
            threadId: linked.file.threadRef.threadId,
          }
        : null;
    })(),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
