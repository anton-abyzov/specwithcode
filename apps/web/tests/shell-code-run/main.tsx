import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId, ThreadId, type RuntimeMode } from "@specweave-studio/contracts";
import ChatMarkdown from "../../src/components/ChatMarkdown";
import { ShellRunTargetContext } from "../../src/components/chat/InlineShellRun";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

// The coordinator reply from the report: an unlabeled fence that used to show as "text".
const coordinatorReply = `The folder you picked holds the store package: the zip, screenshots and notes. Chrome needs the folder that has \`manifest.json\` in it, so unzip the package into its own folder first:

\`\`\`
cd ~/Downloads/specwithcode-browser-cws && mkdir -p unpacked && unzip -o *.zip -d unpacked
\`\`\`

Then click **Load unpacked** and pick \`unpacked\`.`;

const threadReply = `List the folder to see what is missing:

\`\`\`bash
ls -la missing
\`\`\`

Start the dev server:

\`\`\`sh
sleep 30 && pnpm dev
\`\`\``;

function target(runtimeMode: RuntimeMode, threadId: string) {
  return {
    environmentId: EnvironmentId.make("m4"),
    threadId: ThreadId.make(threadId),
    cwd: "/Users/me/Projects/specwithcode",
    worktreePath: null,
    runtimeMode,
  };
}

function Fixture() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <main className="mx-auto max-w-3xl space-y-8 p-5 text-foreground">
            <header>
              <p className="text-sm text-muted-foreground">
                SpecWithCode · isolated shell code run fixture
              </p>
              <h1 className="text-2xl font-semibold">Run commands inline</h1>
            </header>
            <section data-testid="coordinator" aria-label="Coordinator reply, Full access">
              <h2 className="mb-2 text-xs font-medium text-muted-foreground">
                Coordinator · Full access
              </h2>
              <ShellRunTargetContext value={target("full-access", "coordinator")}>
                <ChatMarkdown cwd="/Users/me/Projects/specwithcode" text={coordinatorReply} />
              </ShellRunTargetContext>
            </section>
            <section data-testid="thread" aria-label="Thread reply, Supervised">
              <h2 className="mb-2 text-xs font-medium text-muted-foreground">
                Thread · Supervised
              </h2>
              <ShellRunTargetContext value={target("approval-required", "thread")}>
                <ChatMarkdown cwd="/Users/me/Projects/specwithcode" text={threadReply} />
              </ShellRunTargetContext>
            </section>
          </main>
        </TooltipProvider>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

const rootRoute = createRootRoute({ component: Fixture });
const router = createRouter({
  routeTree: rootRoute,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
