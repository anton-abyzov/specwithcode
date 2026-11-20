/* The production artifact viewer in its overlay, over a thread that named video files. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";

import { ExpandedImageDialog } from "../../src/components/chat/ExpandedImageDialog";
import { ArtifactViewer } from "../../src/components/chat/ThreadArtifacts";
import { ViewerOverlayHost } from "../../src/components/ViewerOverlayHost";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { collectThreadArtifacts } from "../../src/threadArtifacts";
import "./fixture.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark",
);
const cwd = "/Users/fixture/work/atlas";
const threadRef = {
  environmentId: EnvironmentId.make("fixture"),
  threadId: ThreadId.make("fixture-thread"),
};
const artifacts = collectThreadArtifacts(
  [
    {
      id: "m1",
      text: `Cut \`${cwd}/out/landscape.mp4\`, \`${cwd}/out/portrait.mp4\` and \`${cwd}/out/square.png\`.`,
    },
  ],
  cwd,
).toReversed() as never[];

// `?host=expanded`: a video clicked in a chat message opens in the same overlay and stage.
const host = new URLSearchParams(location.search).get("host") ?? "artifact";
const videos = ["landscape", "portrait"].map((name) => ({
  src: `/media/${name}.mp4`,
  name: `${name}.mp4`,
  type: "video" as const,
  autoPlay: false,
}));

function Fixture() {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(true);
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <main className="p-5 text-foreground">
            <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
              Open
            </button>
          </main>
          {open && host === "expanded" ? (
            <ExpandedImageDialog
              threadRef={threadRef}
              preview={{ images: videos, index: 0 }}
              onClose={() => setOpen(false)}
            />
          ) : null}
          {open && host === "artifact" ? (
            <ArtifactViewer
              threadRef={threadRef}
              cwd={cwd}
              artifacts={artifacts}
              index={index}
              onIndex={setIndex}
              onClose={() => setOpen(false)}
            />
          ) : null}
          <ViewerOverlayHost />
        </TooltipProvider>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}
const router = createRouter({
  routeTree: createRootRoute({ component: Fixture }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
