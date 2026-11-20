// The advisor's surfaces over fictional data. Query:
//   ?view=app       Settings > Models: the Advisor section, on with its defaults
//   ?view=project   the project dialog's Advisor section, one field overridden
//   ?view=composer  the composer's options menu with the thread's Advisor row, and the
//                   real options picker on a model with no options of its own;
//                   &thread=fable|opus|passthrough picks the thread's model (mocks.tsx)
//   ?view=timeline  a turn with one consult that gave advice and one that could not
//   ?theme=light|dark
import type { OrchestrationV2ProjectedTurnItem } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { SlidersHorizontalIcon } from "lucide-react";
import { createRoot } from "react-dom/client";

import { AdvisorSettings } from "~/components/settings/AdvisorSettings";
import { SettingsPageContainer } from "~/components/settings/settingsLayout";
import { ThreadAdvisorMenu } from "~/components/chat/ThreadAdvisorMenu";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import { AdvisorConsultRow } from "~/components/chat/AdvisorConsultRow";
import {
  Menu,
  MenuGroup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuPopup,
  MenuTrigger,
} from "~/components/ui/menu";
import { TooltipProvider } from "~/components/ui/tooltip";
import { ENVIRONMENT_ID, ENVIRONMENT_LABEL, fixtureState, fixtureThread, providers } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const view = params.get("view") ?? "app";
fixtureState.scope = view === "project" ? "project" : "app";

const threadRef = { environmentId: ENVIRONMENT_ID, threadId: "thread-atlas-1" } as never;

function AppSettings() {
  return (
    <SettingsPageContainer width="wide" className="gap-8">
      <AdvisorSettings id="advisor" reach={{ kind: "machine", name: ENVIRONMENT_LABEL }} />
    </SettingsPageContainer>
  );
}

/** The project dialog's body around the real section, as ProjectWorkspaceSettings places it. */
function ProjectSettings() {
  return (
    <main className="flex min-h-screen items-start justify-center bg-black/30 px-3 py-6 sm:py-10">
      <div
        role="dialog"
        aria-label="Project settings"
        className="w-full max-w-2xl rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
      >
        <h1 className="px-3 pb-1 text-base font-semibold sm:px-4">atlas</h1>
        <p className="px-3 pb-2 text-xs text-muted-foreground sm:px-4">
          Settings for this project on {ENVIRONMENT_LABEL}
        </p>
        <AdvisorSettings id="project-advisor" className="pt-3" />
      </div>
    </main>
  );
}

const PLAIN_PROVIDER = providers[0]!;

/** A composer foot with the options menu; the effort group stands in for the model's own rows. */
function Composer() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-end gap-6 px-3 pb-10">
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-3 shadow-sm">
        <p className="px-1 pb-8 text-sm text-muted-foreground">Ask for a change, a fix or a plan</p>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="px-1">{fixtureThread.label}</span>
          <span aria-hidden className="h-4 w-px bg-border" />
          <Menu>
            <MenuTrigger
              aria-label="Thread options"
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-accent"
            >
              <SlidersHorizontalIcon aria-hidden className="size-4" />
              High
            </MenuTrigger>
            <MenuPopup side="top" align="start" className="min-w-56">
              <MenuGroup>
                <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                  Effort
                </div>
                <MenuRadioGroup value="high">
                  {["Low", "Medium", "High", "Extra high"].map((label) => (
                    <MenuRadioItem key={label} value={label.toLowerCase()} hideIndicator>
                      {label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
              <ThreadAdvisorMenu threadRef={threadRef} separated />
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {/* The real picker on a model with no options: the menu holds the Advisor group alone. */}
      <div
        data-fixture-plain-composer
        className="w-full max-w-2xl rounded-2xl border border-border bg-card p-3 shadow-sm"
      >
        <p className="px-1 pb-8 text-sm text-muted-foreground">Ask for a change, a fix or a plan</p>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="px-1">Claude Fable 5.2</span>
          <span aria-hidden className="h-4 w-px bg-border" />
          <TraitsPicker
            provider={PLAIN_PROVIDER.driver}
            instanceId={PLAIN_PROVIDER.instanceId}
            models={PLAIN_PROVIDER.models}
            model="claude-fable-5-2"
            prompt=""
            onPromptChange={() => {}}
            planModeEnabled={false}
            threadRef={threadRef}
            advisorRowAvailable
          />
        </div>
      </div>
    </main>
  );
}

const at = (minutes: number) =>
  DateTime.makeUnsafe(new Date(Date.UTC(2026, 10, 16, 15, minutes)).toISOString());

function consult(
  id: string,
  minutes: number,
  item: Record<string, unknown>,
): OrchestrationV2ProjectedTurnItem {
  return {
    sourceThreadId: "thread-atlas-1",
    sourceItemId: id,
    visibility: "visible",
    item: {
      id,
      threadId: "thread-atlas-1",
      runId: "run-1",
      type: "dynamic_tool",
      title: null,
      status: "completed",
      input: {},
      startedAt: at(minutes),
      completedAt: at(minutes + 1),
      createdAt: at(minutes),
      updatedAt: at(minutes + 1),
      ...item,
    },
  } as never;
}

const ADVICE = `Your plan is sound, with two changes:

1. Move the cache flush into \`writeBatch\` before you touch the retry path. The retry reads the cache, so the order matters.
2. Run \`pnpm test stream\` once before you edit the parser. Two of those tests already fail on main, and you should know which ones.

Skip the rename for now. It touches 14 files and nothing in this task needs it.`;

const advice = (value: Record<string, unknown>) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

const consults = [
  consult("consult-advice", 4, {
    toolName: "mcp__studio-code__advisor",
    output: advice({
      status: "advice",
      message: "The advisor answered.",
      advice: ADVICE,
      advisor: "Claude Fable 5.2 on Claude",
      advisorModel: "claude-fable-5-2",
      consultsRemaining: 2,
    }),
  }),
  consult("consult-unavailable", 12, {
    toolName: "advisor",
    status: "failed",
    output: "Advisor unavailable (overloaded)",
  }),
];

function Timeline() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 px-3 py-6 sm:px-6">
      <div className="ms-auto max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-sm">
        Fix the dropped events when the stream reconnects.
      </div>
      <p className="text-sm">
        I found where reconnects drop buffered events. Before I change the flush order, I will check
        the plan with the advisor.
      </p>
      <div data-fixture-timeline className="flex flex-col gap-0.5">
        {consults.map((item, index) => (
          <AdvisorConsultRow
            key={item.sourceItemId}
            projectedItem={item}
            environmentId={ENVIRONMENT_ID as never}
            cwd="/workspace/atlas"
            threadRef={threadRef}
            trailing={
              <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                {index === 0 ? "3:04 PM" : "3:12 PM"}
              </span>
            }
          />
        ))}
      </div>
    </main>
  );
}

const views: Record<string, () => React.JSX.Element> = {
  app: AppSettings,
  project: ProjectSettings,
  composer: Composer,
  timeline: Timeline,
};
const View = views[view] ?? AppSettings;
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <View />
  </TooltipProvider>,
);
