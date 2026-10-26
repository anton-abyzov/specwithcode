/* Isolated fixture: the October 20 report in the app's chat renderer, report reader and viewer overlay. */
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
import { ReportReader } from "../../src/components/chat/ReportReader";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { openFileInFront } from "../../src/lib/openInFront";
import { AUDIT } from "./hostFiles";
import "./fixture.css";

// ?theme=dark
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const threadRef = {
  environmentId: "fixture-host",
  threadId: "thread-1",
} as unknown as ScopedThreadRef;
const CWD = "/Users/you/Projects/github/specweave-umb/repositories/anton-abyzov/specweave";

// The coordinator's words, as the worker wrote them, plus a file the host lacks.
const REPORT = [
  "I've routed follow-ups to 15 owner threads; batch A (coordinator, join/handoff 0948–0951, moves 0947/0954, sidebar, iPhone deployment) is still running. Findings so far are in `~/.specwithcode/audits/2026-10-20/findings-{B,C,D,E}.md`.",
  "",
  "**Evidence:** the full inventory is in `~/.specwithcode/audits/2026-10-20/INVENTORY.md`. A batch that never ran: `~/.specwithcode/audits/2026-10-20/findings-{E,F}.md`.",
].join("\n");

function Root() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <ReportReader
            open
            onOpenChange={() => {}}
            text={REPORT}
            title="Finish every authorized project thread"
            words={454}
            save={null}
            layout={null}
            threadRef={threadRef}
          >
            <ChatMarkdown text={REPORT} cwd={CWD} threadRef={threadRef} isStreaming={false} />
            {/* What 1.0.60 opened for the shorthand: one file that does not exist. */}
            <button
              type="button"
              data-open-literal="true"
              className="mt-6 text-sm underline"
              onClick={() =>
                openFileInFront({
                  environmentId: threadRef.environmentId,
                  threadRef,
                  cwd: CWD,
                  path: `${AUDIT}/findings-{B,C,D,E}.md`,
                  line: undefined,
                })
              }
            >
              Open the old shorthand link
            </button>
          </ReportReader>
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
