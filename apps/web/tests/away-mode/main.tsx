import type { AwayPlan, AwaySession, EnvironmentId } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { AwayDialogView, type AwayDialogViewProps } from "../../src/components/away/AwayDialog";
import { AwayWakeCardView } from "../../src/components/away/AwayWakeCard";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") || "plan";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const M4 = "env-m4" as EnvironmentId;
const MINI = "env-ministorm" as EnvironmentId;
const noop = () => {};

// A plan the target is not ready for: Ministorm has not let M4 manage routines.
const plan: AwayPlan = {
  targetEnvironmentId: MINI,
  targetLabel: "Ministorm",
  items: [
    {
      kind: "thread",
      id: "t1",
      title: "Fix the build",
      action: "move",
      reason: "Moves to Ministorm.",
    },
    {
      kind: "thread",
      id: "t2",
      title: "Write docs",
      action: "handoff-ready",
      reason: "Ministorm: no .env.local",
    },
    {
      kind: "routine",
      id: "r1",
      title: "Nightly report",
      action: "move",
      reason: "Runs on Ministorm on the same schedule.",
    },
    {
      kind: "routine",
      id: "r2",
      title: "Deploy hook",
      action: "pause",
      reason: "Its URL belongs to this machine, so it pauses here while you are away.",
    },
    { kind: "coordinator", id: "p1", title: "Insta", action: "move", reason: "Hands over." },
  ],
  missingGrants: [
    {
      kind: "routines",
      machineEnvironmentId: MINI,
      machineLabel: "Ministorm",
      detail: "Ministorm does not let M4's coordinator manage routines.",
      fix: "On Ministorm, turn on Routines for M4 in Settings > Machines > Who can run work here.",
    },
  ],
  ready: false,
  checkedAt: "2026-11-09T10:00:00.000Z",
};

const running: AwaySession = {
  sessionId: "s1",
  targetEnvironmentId: MINI,
  targetLabel: "Ministorm",
  trigger: "manual",
  coordinatorScope: "live",
  startedAt: "2026-11-09T10:00:00.000Z",
  finishedAt: null,
  stage: "routines",
  bringBackStartedAt: null,
  broughtBackAt: null,
  items: [
    {
      kind: "coordinator",
      id: "p1",
      title: "Insta",
      outcome: "moved",
      detail: "Ministorm coordinates Insta now.",
    },
    {
      kind: "routine",
      id: "r1",
      title: "Nightly report",
      outcome: "pending",
      detail: "Moving to Ministorm.",
    },
    {
      kind: "routine",
      id: "r2",
      title: "Deploy hook",
      outcome: "paused",
      detail: "Its URL belongs to this machine, so it is paused here until you are back.",
    },
    { kind: "thread", id: "t1", title: "Fix the build", outcome: "pending", detail: "Waiting." },
    {
      kind: "thread",
      id: "t2",
      title: "Write docs",
      outcome: "handoff-ready",
      detail: "Ministorm: no .env.local",
    },
  ],
};

const base: AwayDialogViewProps = {
  intent: "away",
  destinations: [{ environmentId: MINI, label: "Ministorm", state: "reachable" }],
  target: MINI,
  onTarget: noop,
  plan,
  checking: false,
  error: null,
  requesting: false,
  request: null,
  requestError: null,
  onRequestAccess: noop,
  onRecheck: noop,
  onClose: noop,
  onLeave: noop,
  selfEnvironmentId: M4,
  selfLabel: "M4",
};

function Fixture() {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground" data-testid="fixture">
      {view === "plan" ? <AwayDialogView {...base} /> : null}
      {view === "running" ? (
        <AwayDialogView
          {...base}
          session={running}
          running
          onBringBack={noop}
          onOpenThread={noop}
        />
      ) : null}
      {view === "wake" ? (
        <AwayWakeCardView
          targetLabel="Ministorm"
          bringing={false}
          error={null}
          onBringBack={noop}
          onLater={noop}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
