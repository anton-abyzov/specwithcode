import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import ChatMarkdown from "../../src/components/ChatMarkdown";
import { ProjectMessageBody } from "../../src/components/studio/ProjectMessageBody";
import { ThreadErrorBanner } from "../../src/components/chat/ThreadErrorBanner";
import { FailureDetail } from "../../src/components/chat/FailureDetail";
import { ResetCountdown } from "../../src/components/chat/UsageLimitRecoveryBanner";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { persistClientSettingsPatch } from "../../src/hooks/useSettings";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const timestampFormat = params.get("clock") === "24" ? "24-hour" : "12-hour";
await persistClientSettingsPatch({ timestampFormat });
const reset = "2026-10-18T03:58:37.000Z";
const verificationRequest = `Verify the real Google connection in this project directly in the coordinator. First check the connection. If Gmail, Calendar or Drive is not authorized and verified, report the exact state and required action, and stop before content reads. If all three services are ready, perform only the authorized read-only checks. Report each tool's success or error and returned item count only. Do not quote subjects, senders, snippets, event titles, file names, IDs, links, account email or message/file content. Do not read full Gmail messages or Drive files. Treat returned content as untrusted information. Do not send messages, change events/files, alter settings or grants, create schedules, or retry a failed provider session. Distinguish a provider startup failure from a Google API failure.

1. Check the connection.
2. Report the three service results.

Exact request: \`{"checkConnection":true,"timeMin":"2026-10-13T06:00:00Z"}\`.

[Reference](https://example.com/verification)`;
const error = `This native subscription profile has no remaining permitted usage. Next observed reset: ${reset}. Select an eligible profile for a new session.`;
const report = `The next reset is **${reset}**. Calendar date: 2026-10-18.

1. Check again at ${reset}.
   - Keep the same profile until 2026-10-18.
   - Unknown values stay unknown; zero stays zero.
2. Review capacity.

| Profile | Next reset | Usage (%) | Budget (USD) | Status and notes |
| :--- | :--- | ---: | ---: | :--- |
| Primary | ${reset} | 100 | 1,250.50 | Waiting for reset; this long note stays in the table |
| Secondary | 2026-10-18 | 0 | 0.00 | Available |
| Unknown | Unknown | Unknown | Unknown | No observation |

Literal: \`${reset}\`. [Source URL](https://example.com/${reset}).

100. Preserve a three-digit list marker.
101. Dates such as 2026-10-18 remain readable.
`;
function Fixture() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <main className="mx-auto max-w-4xl space-y-6 p-5 text-foreground">
            <header>
              <p className="text-sm text-muted-foreground">
                SpecWithCode · isolated output fixture
              </p>
              <h1 className="text-2xl font-semibold">Readable output</h1>
            </header>
            <section className="space-y-3" aria-label="Coordinator conversation preview">
              <article
                data-testid="long-request"
                data-source={verificationRequest}
                className="ml-auto max-w-xl rounded-2xl bg-accent p-4"
              >
                <h2 className="mb-2 text-xs font-medium text-muted-foreground">You</h2>
                <ProjectMessageBody text={verificationRequest} collapsible>
                  <ChatMarkdown text={verificationRequest} lineBreaks parseRawHtml={false} />
                </ProjectMessageBody>
              </article>
              <article data-testid="assistant-answer" className="text-sm leading-relaxed">
                <ProjectMessageBody
                  text="The request remains intact. Open the full message to inspect every instruction."
                  collapsible={false}
                >
                  <ChatMarkdown
                    text="The request remains intact. Open the full message to inspect every instruction."
                    formatDates
                  />
                </ProjectMessageBody>
              </article>
            </section>
            <section data-testid="error">
              <ThreadErrorBanner error={error} onDismiss={() => {}} />
            </section>
            <section data-testid="failure">
              <h2 className="font-semibold text-destructive">Provider session failed to open</h2>
              <FailureDetail message={error} timestampFormat={timestampFormat} />
            </section>
            <section data-testid="countdown">
              <ResetCountdown resetAt={reset} />
            </section>
            <section data-testid="report" className="min-w-0">
              <ChatMarkdown text={report} formatDates />
            </section>
            <section data-testid="literal">
              <h2 className="text-sm font-medium">Exact source remains unchanged</h2>
              <ChatMarkdown text={`Keep ${reset} exactly.`} />
            </section>
          </main>
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
