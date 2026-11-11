/* Isolated messages: the production ChatMarkdown with media named by path, no host. */
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";

import ChatMarkdown from "../../src/components/ChatMarkdown";
import { ViewerOverlayHost } from "../../src/components/ViewerOverlayHost";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
// `?before`: the messages as they rendered before the fallback existed.
const mediaFallback = !params.has("before");
const cwd = "/Users/fixture/work/atlas";
const threadRef = {
  environmentId: EnvironmentId.make("fixture"),
  threadId: ThreadId.make("fixture-thread"),
};

const CASES: ReadonlyArray<{ id: string; title: string; text: string; streaming?: boolean }> = [
  {
    id: "chip",
    title: "A screenshot named by path",
    text: `The settings page now keeps its header on narrow screens.\n\nScreenshot: \`${cwd}/shots/after.png\`. Full notes are in \`${cwd}/reports/notes.md\`.`,
  },
  {
    id: "several",
    title: "Several files: only the first shows",
    text: `Captured both states: [before](${cwd}/shots/before.png) and \`${cwd}/shots/after.png\`.`,
  },
  {
    id: "embedded",
    title: "The author's own image wins",
    text: `Here is the result.\n\n![The settings page](${cwd}/shots/embedded.png)\n\nAlso saved as \`${cwd}/shots/after.png\`.`,
  },
  {
    id: "missing",
    title: "A file that cannot be read leaves the chip alone",
    text: `Saved on the other machine: \`/Users/fixture/missing/remote.png\`.`,
  },
  {
    id: "video",
    title: "A recording named by path",
    text: `Recording of the flow: \`${cwd}/shots/demo.webm\`.`,
  },
  {
    id: "streaming",
    title: "A reply still streaming waits",
    text: `Saving the screenshot to \`${cwd}/shots/after.png\``,
    streaming: true,
  },
];

function Fixture() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <main className="mx-auto max-w-2xl space-y-6 p-5 text-foreground">
            <header>
              <p className="text-sm text-muted-foreground">
                SpecWithCode · isolated inline media fixture
              </p>
              <h1 className="text-2xl font-semibold">
                {mediaFallback ? "Media named by path shows a thumbnail" : "Before: a chip only"}
              </h1>
            </header>
            {CASES.map((item) => (
              <section key={item.id} data-testid={item.id} className="space-y-2">
                <h2 className="text-xs font-medium text-muted-foreground">{item.title}</h2>
                <ChatMarkdown
                  text={item.text}
                  cwd={cwd}
                  threadRef={threadRef}
                  isStreaming={item.streaming === true}
                  mediaFallback={mediaFallback}
                  formatDates
                />
              </section>
            ))}
          </main>
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
