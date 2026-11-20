/* Synthetic data only (1427 AC-09): a window served by M5 ("this-mac") that shows linux-mini's
   coordinator. One page holds the sidebar header, the project header's tag, the machine menu,
   a reply with its label and source chip, the user's message label, a relayed note, a
   thread chip and the coordinator's question card, all from the real components and phrases. `?theme=dark`, `?lang=`. */
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { SidebarWindowMachine } from "../../src/components/sidebar/SidebarWindowMachine";
import { RuntimeRequestId } from "@specweave-studio/contracts";
import { CoordinatorMessageCard } from "../../src/components/studio/CoordinatorMessageCard";
import { stepNotification } from "../../src/studio/coordinatorMessages";
import type { CoordinatorMessageView } from "@specweave-studio/contracts";
import { CoordinatorMachineTag } from "../../src/components/studio/CoordinatorMachineTag";
import { CoordinatorQuestionCard } from "../../src/components/studio/CoordinatorQuestionCard";
import type { CoordinatorQuestion } from "../../src/components/studio/useCoordinatorQuestion";
import { CoordinatorReplySources } from "../../src/components/studio/CoordinatorReplySources";
import { OrchestratorSwitcher } from "../../src/components/studio/OrchestratorSwitcher";
import { ThreadLinkChipButton } from "../../src/components/ThreadLinkChip";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { isLocale, setLocalePreference, useTx } from "../../src/i18n";
import {
  ConversationMachineContext,
  senderWithMachine,
} from "../../src/studio/conversationMachine";
import { coordinatorExecutionLabel } from "../../src/studio/machineLabels";
import type { OrchestratorCopy } from "../../src/studio/projectCoordinatorMachine";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
const lang = params.get("lang");
if (lang && isLocale(lang)) setLocalePreference(lang);

const WINDOW = "this-mac";
const SHOWN = "linux-mini";
const copy = (environmentId: string, machine: string): OrchestratorCopy => ({
  key: `${environmentId}:atlas`,
  machine,
  folder: "~/Projects/atlas",
  role: "coordinator",
  main: environmentId === SHOWN,
  rowRole: "linked",
  label: null as never,
  canStart: true,
});
const COPIES = [copy(SHOWN, "linux-mini"), copy(WINDOW, "M5")];
const RUNS = [
  { id: "run-1", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } },
];
/** A worker of linux-mini's coordinator that runs on M5. */
const worker = {
  environmentId: WINDOW,
  id: "thread-release",
  projectId: "atlas",
  title: "Release notes",
  latestRun: { status: "running" },
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  archivedAt: null,
} as unknown as EnvironmentThreadShell;

/** linux-mini's coordinator asks; the answer goes to linux-mini. */
const ASK = {
  requestId: RuntimeRequestId.make("request-1"),
  responseCapability: "live",
  createdAt: "2026-11-19T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Sign-in",
      question: "Sign in to Codex again on M5 now?",
      options: [
        { label: "Sign in now", description: "Open the sign-in on M5" },
        { label: "Later", description: "Keep the thread waiting" },
      ],
      multiSelect: false,
    },
  ],
  dismissible: true,
} as const;
const QUESTION = {
  requests: [ASK],
  active: ASK,
  askedBy: "Coordinator",
  answers: {},
  questionIndex: 0,
  progress: { canAdvance: false } as never,
  respondingRequestIds: [],
  disabled: false,
  composerCanAnswer: false,
  toggleOption: () => {},
  advance: () => {},
  previous: () => {},
  dismiss: () => {},
  answerFromDraft: async () => ({ keepUploads: false }),
} as unknown as CoordinatorQuestion;

/** 1427 AC-20: M5's coordinator reports a problem three times with a step on M5; linux-mini
 *  asked M5 for the logs and M5 replied. */
const hex = (c: string) => `cm-${c.repeat(40)}`;
const MESSAGE = (over: Partial<CoordinatorMessageView>): CoordinatorMessageView =>
  ({
    id: hex("a"),
    externalId: hex("a"),
    direction: "incoming",
    peerEnvironmentId: WINDOW,
    kind: "problem",
    subject: "Codex is signed out",
    text: "The release worker stopped: Codex needs a new sign-in.",
    refs: [],
    count: 1,
    state: "delivered",
    receivedAt: 1_763_510_400_000,
    updatedAt: 1_763_510_400_000,
    ...over,
  }) as CoordinatorMessageView;
const PROBLEM = MESSAGE({
  count: 3,
  userStep: { environmentId: WINDOW, text: "sign in to Codex again" } as never,
  refs: [
    {
      kind: "thread",
      environmentId: WINDOW,
      threadId: "thread-release",
      title: "Release notes",
      statusAtSend: "waiting",
    } as never,
  ],
});
const ASKED = MESSAGE({
  id: hex("b"),
  externalId: hex("b"),
  direction: "outgoing",
  kind: "request",
  subject: "Send the build log",
  text: "",
  state: "answered",
  receivedAt: 1_763_510_500_000,
});
const REPLY = MESSAGE({
  id: hex("c"),
  externalId: hex("c"),
  kind: "reply",
  subject: "Build log attached",
  text: "The log is in the release report.",
  replyTo: hex("b") as never,
  state: "read",
  receivedAt: 1_763_510_600_000,
  refs: [{ kind: "report", environmentId: WINDOW, path: "/reports/build-log.md" } as never],
});
const ALL = [PROBLEM, ASKED, REPLY];

function StepNotificationPreview() {
  const tx = useTx();
  const { title, body } = stepNotification({
    step: "sign in to Codex again",
    stepMachine: "M5",
    sender: "M5",
    project: "Atlas",
    tx,
  });
  return (
    <div className="fixture-notification" data-step-notification="">
      <strong data-step-title="">{title}</strong>
      <span data-step-body="">{body}</span>
    </div>
  );
}

function Page() {
  const tx = useTx();
  const say = (words: { text: string; values?: Readonly<Record<string, string>> }) =>
    tx(words.text, words.values);
  return (
    <div className="fixture-page">
      <div className="fixture-row" data-fixture="sidebar-header">
        <span className="text-sm font-medium">SpecWithCode</span>
        <SidebarWindowMachine />
      </div>
      <div className="sws-topbar fixture-row" data-fixture="project-header">
        <div className="sws-project-id">
          <h1>Atlas</h1>
          <CoordinatorMachineTag shownEnvironmentId={SHOWN} windowEnvironmentId={WINDOW} />
        </div>
      </div>
      <div className="fixture-row" data-fixture="switcher">
        <OrchestratorSwitcher
          label="linux-mini"
          projectTitle="Atlas"
          connected
          statusDetail=""
          current={`${SHOWN}:atlas`}
          copies={COPIES}
          unknown={[]}
          savedMachineMissing={false}
          onView={() => {}}
          onAllowWorkers={null}
          windowEnvironmentId={WINDOW}
        />
      </div>
      <ConversationMachineContext value={SHOWN}>
        <div className="project-conversation" data-fixture="conversation">
          <article className="project-message project-message-user">
            <h3>You</h3>
            <p className="project-muted" data-request-execution="">
              {say(
                coordinatorExecutionLabel(
                  { role: "user", createdBy: "user", runId: "run-1" },
                  RUNS,
                  "linux-mini",
                ),
              )}
            </p>
            <p>Why is Codex signed out on M5?</p>
          </article>
          <article className="project-message project-message-assistant">
            <h3>Coordinator</h3>
            <CoordinatorReplySources
              sources={[
                {
                  kind: "thread",
                  threadId: "thread-release",
                  environmentId: WINDOW,
                  title: "Release notes",
                } as never,
                {
                  kind: "thread",
                  threadId: "thread-local",
                  environmentId: SHOWN,
                  title: "Sign-in check",
                } as never,
              ]}
              onOpenThread={() => {}}
            />
            <p className="project-muted" data-request-execution="">
              {say(
                coordinatorExecutionLabel(
                  { role: "assistant", runId: "run-1" },
                  RUNS,
                  "linux-mini",
                ),
              )}
            </p>
            <p>
              On M5: sign in to Codex again, then continue{" "}
              <ThreadLinkChipButton thread={worker} label="Release notes" onOpen={() => {}} />.
            </p>
          </article>
          <article className="project-message project-message-relay">
            <p className="project-muted" data-relayed-from="">
              {`Message from ${senderWithMachine(worker, SHOWN)}`}
            </p>
          </article>
        </div>
      </ConversationMachineContext>
      <div data-fixture="coordinator-messages">
        <CoordinatorMessageCard messages={[PROBLEM]} all={ALL} />
        <CoordinatorMessageCard messages={[ASKED]} all={ALL} />
        <StepNotificationPreview />
      </div>
      <div data-fixture="question">
        <CoordinatorQuestionCard
          question={QUESTION}
          environmentId={SHOWN as never}
          cwd={undefined}
          onAnswerElsewhere={() => {}}
        />
      </div>
    </div>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: Page }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <RouterProvider router={router} />
  </TooltipProvider>,
);
