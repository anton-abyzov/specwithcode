import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import ChatMarkdown from "../../src/components/ChatMarkdown";
import { useComposerDraftStore } from "../../src/composerDraftStore";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
document.body.style.backgroundColor = dark ? "#1f1f1f" : "#fafafa";

// A fictional thread and project; no server, no provider turn.
const threadRef = {
  environmentId: EnvironmentId.make("fixture-env"),
  threadId: ThreadId.make("thread:fixture-outside-document"),
};

const BEFORE =
  '**Blockers:** Two things are yours from the "Finish the release prep" session. First, the nine calls in its report [Release checklist](https://claude.ai/artifact/Xq7Lm2Rt9Vb4Nc8Pd3Kf6H). The release notes are in [the changelog](https://example.com/changelog).';
const AFTER =
  '**Blockers:** Two things are yours from the "Finish the release prep" session. First, the nine calls in its report [Release checklist](/tmp/fixture-project/.specweave/reports/threads/2026-11-13-release-checklist-what-is-unfinished-3f2a1c-9b7e0d.md). The release notes are in [the changelog](https://example.com/changelog).';

function Composer() {
  const prompt = useComposerDraftStore((state) => state.getComposerDraft(threadRef)?.prompt ?? "");
  return (
    <textarea
      data-fixture-composer
      readOnly
      value={prompt}
      placeholder="Ask anything"
      className="block h-28 w-full rounded-2xl border bg-background p-3 text-sm"
    />
  );
}

function Fixture() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <main className="mx-auto flex max-w-[760px] flex-col gap-6 p-6">
            <section data-fixture="outside" className="text-sm leading-relaxed">
              <p className="mb-2 text-muted-foreground text-xs">Link to a claude.ai page</p>
              <ChatMarkdown cwd="/tmp/fixture-project" threadRef={threadRef} text={BEFORE} />
            </section>
            <section data-fixture="saved" className="text-sm leading-relaxed">
              <p className="mb-2 text-muted-foreground text-xs">After it is saved as a report</p>
              <ChatMarkdown cwd="/tmp/fixture-project" threadRef={threadRef} text={AFTER} />
            </section>
            <Composer />
          </main>
        </TooltipProvider>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({ component: Fixture }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
