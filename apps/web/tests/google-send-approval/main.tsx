import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { RuntimeRequestId } from "@specweave-studio/contracts";
import { GoogleAccountSettingsPanel } from "../../src/components/settings/GoogleAccountSettings";
import { ComposerPendingUserInputPanel } from "../../src/components/chat/ComposerPendingUserInputPanel";
import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import ChatMarkdown from "../../src/components/ChatMarkdown";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import type { PendingUserInput } from "../../src/session-logic";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
document.body.classList.add("bg-background", "text-foreground");
// Mirrors the backend card contract; server tests separately exercise the actual builder.
const body =
  "Review the entire fictional plain-text message. ".repeat(45) +
  "\n[This is literal text](https://example.invalid/not-a-link)\nEND OF APPROVED MESSAGE";
const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("gmail-send:v2:fixture:offline"),
  createdAt: "2026-11-03T00:00:00.000Z",
  responseCapability: "message",
  responseMode: "message",
  dismissible: true,
  questions: [
    {
      id: "draft:d1:snapshot:fixture",
      header: "Reply to colleague@example.invalid from reviewer@example.invalid",
      question: `Send this exact copy from reviewer@example.invalid? The original draft will remain in Gmail after sending.\n\n\`\`\`text\nfrom: reviewer@example.invalid\nto: colleague@example.invalid\ncc: teammate@example.invalid\nbcc: audit@example.invalid\nsubject: Re: Review fixture\n\n${body}\n\`\`\``,
      options: [
        {
          label: "Send",
          description:
            "Send this exact copy from reviewer@example.invalid; keep the original draft.",
        },
        {
          label: "Don't send",
          description: "Keep it as a draft in Gmail. To change it, reply in chat instead.",
        },
      ],
      allowCustomAnswer: true,
    },
  ],
};
function Fixture() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <main className="mx-auto max-w-2xl space-y-8 p-4">
            <h1>Offline Gmail approval fixture</h1>
            <div data-fixture="settings">
              <GoogleAccountSettingsPanel />
            </div>
            <section data-fixture="approval">
              <ComposerBanner.Root>
                <ComposerPendingUserInputPanel
                  pendingUserInputs={[prompt]}
                  respondingRequestIds={[]}
                  answers={{}}
                  questionIndex={0}
                  onToggleOption={() => {}}
                  onAdvance={() => {}}
                  onDismiss={() => {}}
                  renderText={(text) => <ChatMarkdown text={text} cwd="/fictional" />}
                />
              </ComposerBanner.Root>
            </section>
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
