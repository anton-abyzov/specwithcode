/* Isolated fixture: Markdown files opened from a chat message in the app's document reader. */
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ScopedThreadRef } from "@specweave-studio/contracts";

import ChatMarkdown from "../../src/components/ChatMarkdown";
import { ViewerOverlayHost } from "../../src/components/ViewerOverlayHost";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { FIXTURE_DOCS, HOST_FILES } from "./hostFiles";
import "./fixture.css";

// ?theme=dark
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

// verify.mjs may hand in a local file to check (never committed): { path: contents }.
const extra = (window as { __EXTRA_DOCS__?: Record<string, string> }).__EXTRA_DOCS__ ?? {};
for (const [path, contents] of Object.entries(extra)) HOST_FILES.set(path, contents);

const threadRef = {
  environmentId: "fixture-host",
  threadId: "thread-1",
} as unknown as ScopedThreadRef;
const CWD = "/Users/example/Projects/console";

const MESSAGE = [
  ...Object.entries(FIXTURE_DOCS).map(([name, path]) => `- ${name}: [${name}](${path})`),
  ...Object.keys(extra).map((path) => `- local: [local](${path})`),
].join("\n");

function Root() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <main className="mx-auto max-w-3xl p-6">
            <ChatMarkdown text={MESSAGE} cwd={CWD} threadRef={threadRef} isStreaming={false} />
          </main>
          <ViewerOverlayHost />
        </TooltipProvider>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

// Chips read the router (thread links), as they do in the app.
const router = createRouter({
  routeTree: createRootRoute({ component: Root }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
