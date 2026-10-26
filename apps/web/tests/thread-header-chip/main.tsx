/*
 * Synthetic data only: the real ProjectThreadHeader as Anton's October 26 screenshot shows
 * it, a Codex GPT-6-Astra thread on a usage-limit fallback for Opus 5.5 with 21 subagents,
 * 8 artifacts, the Concise style and the chat's three panel toggles beside it.
 *
 * `?theme=dark` the theme, `?electron=1` the desktop title bar's drag region,
 * `?scenario=plain` a thread on its own pick, `?scenario=account` a second Codex
 * account, `?scenario=busy` a routing decision and an open pull request after the
 * model chip, `?title=long` an agent-named title of 112 characters. The runner sets the
 * panel width with the viewport.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ModelSelection,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { PanelBottomIcon, PanelRightIcon, SquareMenuIcon } from "lucide-react";
import { ProjectThreadHeader } from "../../src/components/studio/shell/ProjectThreadHeader";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const scenario = params.get("scenario") ?? "fallback";

const host = EnvironmentId.make("env-m4");
const astra = {
  instanceId: ProviderInstanceId.make(scenario === "account" ? "codex_work" : "codex"),
  model: "gpt-6-astra",
} as ModelSelection;
const opus = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
} as ModelSelection;
const fallback = scenario !== "plain";

const thread = {
  id: "thread-0932",
  environmentId: host,
  projectId: "project",
  title:
    params.get("title") === "long"
      ? "Finish increments 0932-0934 (vSkill, cards, skills view), then verify the installed app on every paired machine"
      : "Finish increments 0932-0934 (vSkill, cards, skills view)",
  createdBy: "agent",
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  settledOverride: null,
  lineage: { relationshipToParent: null },
  pullRequests:
    scenario === "busy"
      ? [
          {
            host: "github.com",
            repository: "anton-abyzov/fixture",
            number: 830,
            url: "https://github.com/anton-abyzov/fixture/pull/830",
            source: "agent",
            linkedAt: "2026-10-26T15:00:00.000Z",
            snapshot: null,
            stack: null,
          },
        ]
      : [],
  archivedAt: null,
  deletedAt: null,
  worktreePath: null,
  updatedAt: "2026-10-26T15:40:00.000Z",
  createdAt: "2026-10-19T13:28:30.000Z",
  modelSelection: fallback ? opus : astra,
  modelIdentity: {
    current: astra,
    preferred: fallback ? opus : null,
    kind: fallback ? "fallback" : null,
  },
} as unknown as EnvironmentThreadShell;

/** The chat's panel toggles, portaled into the header's tools slot as ChatView does. */
function Tools(props: { slot: HTMLSpanElement | null }) {
  if (!props.slot) return null;
  return createPortal(
    <>
      <button type="button" className="sws-icon-button" aria-label="Toggle thread details">
        <SquareMenuIcon aria-hidden />
      </button>
      <button type="button" className="sws-icon-button" aria-label="Toggle terminal drawer">
        <PanelBottomIcon aria-hidden />
      </button>
      <button type="button" className="sws-icon-button" aria-label="Toggle right panel">
        <PanelRightIcon aria-hidden />
      </button>
    </>,
    props.slot,
  );
}

function Harness() {
  const [slot, setSlot] = useState<HTMLSpanElement | null>(null);
  return (
    <div data-panel>
      <ProjectThreadHeader
        thread={thread}
        subagents={[]}
        onPeekSubagent={() => {}}
        providerEntry={null}
        projectCwd="/tmp/fixture"
        canChange
        expanded={false}
        onBack={() => {}}
        onToggleResolved={() => {}}
        onToggleExpanded={() => {}}
        onClose={() => {}}
        onOpenPullRequest={() => {}}
        toolsSlotRef={setSlot}
      />
      <Tools slot={slot} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Harness />
  </TooltipProvider>,
);
requestAnimationFrame(() => document.body.setAttribute("data-fixture-ready", ""));
