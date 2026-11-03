// Headless fixture: the real Tiptap composer editor wired the way ChatComposer
// wires the suggested prompt: the same derivation, gate and key decision.
import { RunId } from "@specweave-studio/contracts";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../../src/components/ComposerPromptEditor";
import {
  composerGhostSuggestionKeyAction,
  latestRunPromptSuggestion,
  visibleComposerGhostSuggestion,
} from "../../src/components/chat/composerGhostSuggestion";
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { SessionPhase } from "../../src/types";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
const phase = (params.get("phase") ?? "ready") as SessionPhase;
const text =
  params.get("text") ??
  "Run the unit tests for the composer and fix anything that fails before opening the pull request";
const runs = [
  { id: RunId.make("run-1"), ordinal: 1, status: "completed" as const },
  {
    id: RunId.make("run-2"),
    ordinal: 2,
    status: "completed" as const,
    promptSuggestion: { text, source: "provider" as const },
  },
];
const EMPTY_CONTEXT = new Map();

function Fixture() {
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<"default" | "plan">("default");
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const promptRef = useRef("");
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const ghost = visibleComposerGhostSuggestion({
    suggestion: latestRunPromptSuggestion(runs, "all"),
    dismissedRunId,
    phase,
    isSendBusy: false,
    isConnecting: false,
    isApprovalState: false,
    hasPendingUserInput: false,
    showPlanFollowUpPrompt: false,
    environmentUnavailable: false,
    projectSelectionRequired: false,
    isEditingQueuedMessage: false,
    draftHasUserContent: prompt.trim().length > 0,
    prompt,
  });

  // Same order as ChatComposer's onComposerCommandKey: plan toggle, ghost, rest.
  const onCommandKey = (key: string, event: KeyboardEvent) => {
    if (key === "Tab" && event.shiftKey) {
      setMode((current) => (current === "plan" ? "default" : "plan"));
      return true;
    }
    const action = composerGhostSuggestionKeyAction(event, {
      ghostVisible: ghost !== null && promptRef.current === "",
      menuIsActive: false,
      hasSubmissionIntent: false,
    });
    if (action !== null && ghost !== null) {
      if (action === "dismiss") {
        setDismissedRunId(ghost.runId);
        return true;
      }
      promptRef.current = ghost.text;
      setPrompt(ghost.text);
      setCursor(ghost.text.length);
      window.requestAnimationFrame(() => editorRef.current?.focusAt(ghost.text.length));
      return true;
    }
    return false;
  };

  return (
    <main
      className="flex min-h-screen flex-col justify-end bg-background px-3 pb-6 sm:px-5"
      data-interaction-mode={mode}
      data-phase={phase}
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <form
            className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
            data-chat-composer-form="true"
          >
            <ComposerSurface.Main>
              <div className="px-3 pt-3 pb-2 sm:px-4">
                <ComposerPromptEditor
                  ariaLabel="Message"
                  editorRef={editorRef}
                  value={prompt}
                  cursor={cursor}
                  contextRecords={EMPTY_CONTEXT}
                  skills={[]}
                  disabled={false}
                  ghostSuggestion={ghost?.text ?? null}
                  placeholder="Ask anything, @tag files/folders, $use skills, or / for commands"
                  onChange={(next, nextCursor) => {
                    promptRef.current = next;
                    setPrompt(next);
                    setCursor(nextCursor);
                  }}
                  onCommandKeyDown={onCommandKey}
                  onPaste={() => {}}
                />
                <div className="mt-2 text-xs text-muted-foreground">
                  Claude Code, Opus 5.5 · {mode === "plan" ? "Plan" : "Build"}
                </div>
              </div>
            </ComposerSurface.Main>
          </form>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Fixture />
  </TooltipProvider>,
);
