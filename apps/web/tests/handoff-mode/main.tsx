import { DEFAULT_HANDOFF_CONFIG } from "@specweave-studio/contracts";
import type {
  EnvironmentId,
  ProjectId,
  HandoffMachineRun,
  HandoffPreflightResult,
  ThreadId,
} from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import {
  HandoffBadgeActions,
  HandoffBadgeChip,
  ResumeMachineDialogView,
} from "../../src/components/handoff/HandoffBadge";
import { HandOffMachineDialogView } from "../../src/components/handoff/HandOffMachineDialog";
import type { HandoffDestination } from "../../src/components/handoff/HandoffResults";
import { HandOffThreadDialogView } from "../../src/components/handoff/HandOffThreadDialog";
import { HandoffModeSettingsView } from "../../src/components/settings/HandoffModeSettings";
import { ProjectHandoffModeSettingsView } from "../../src/components/settings/ProjectHandoffModeSettings";
import type { HandoffBadgeView } from "../../src/studio/handoffMode";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") || "badges";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const M4 = "env-m4" as EnvironmentId;
const MINIS = "env-minis" as EnvironmentId;
const M3 = "env-m3" as EnvironmentId;
const tid = (id: string) => id as ThreadId;
const noop = () => {};

const destinations: HandoffDestination[] = [
  { environmentId: M4, label: "M4", state: "this-machine" },
  { environmentId: MINIS, label: "Minis", state: "reachable" },
  { environmentId: M3, label: "M3", state: "offline" },
];

const rows: Array<{ title: string; model: string; badge: HandoffBadgeView }> = [
  {
    title: "Fix the release build",
    model: "Opus 5.5",
    badge: { kind: "ready", label: "Ready to move" },
  },
  {
    title: "Migrate settings storage",
    model: "Sonnet 5.5",
    badge: { kind: "behind", label: "Syncing", detail: "Minis: retrying" },
  },
  {
    title: "Write the release notes",
    model: "Opus 5.5",
    badge: { kind: "handing-off", label: "Moving…" },
  },
  {
    title: "Phone pairing review",
    model: "Opus 5.5",
    badge: {
      kind: "continued",
      label: "Moved to Minis",
      machine: "Minis",
      environmentId: MINIS,
      threadId: tid("t-9"),
    },
  },
  {
    title: "Checkpoint replication tests",
    model: "Opus 5.5",
    badge: {
      kind: "source-unreachable",
      label: "M3 is offline",
      machine: "M3",
      replica: { sourceEnvironmentId: M3, sourceThreadId: tid("t-5") } as never,
    },
  },
  {
    title: "Sleep handoff flush",
    model: "Sonnet 5.5",
    badge: { kind: "paused", label: "Paused: offline" },
  },
];

function Badges() {
  return (
    <div className="sws-thread-list" style={{ maxWidth: 560 }}>
      {rows.map((row) => (
        <article key={row.title} className="sws-thread-row project-thread-card" data-tone="idle">
          <button type="button" className="sws-thread-open">
            <span className="sws-dot" data-tone="none" aria-hidden />
            <span className="sws-thread-text">
              <strong>{row.title}</strong>
              <span className="sws-thread-meta">
                <span>{row.model}</span>
                <HandoffBadgeChip badge={row.badge} className="sws-thread-handoff-chip" />
              </span>
            </span>
            <time className="sws-thread-age">4m</time>
          </button>
          {row.badge.kind === "source-unreachable" || row.badge.kind === "paused" ? (
            <span className="sws-thread-handoff-action">
              <HandoffBadgeActions
                badge={row.badge}
                environmentId={M4}
                localEnvironmentId={M4}
                onOpenThread={noop}
              />
            </span>
          ) : null}
        </article>
      ))}
      <div
        className="sws-thread-head"
        style={{ display: "flex", gap: 8, padding: 12, alignItems: "center" }}
      >
        <h2 style={{ fontWeight: 600 }}>Phone pairing review</h2>
        <HandoffBadgeChip badge={rows[3]!.badge} />
        <HandoffBadgeActions
          badge={rows[3]!.badge}
          environmentId={M4}
          localEnvironmentId={M4}
          onOpenThread={noop}
        />
      </div>
    </div>
  );
}

const failing: HandoffPreflightResult = {
  threadId: tid("t-1"),
  title: "Fix the release build",
  ok: false,
  failures: [
    { check: "ignored-files", message: "Minis: no .env.local" },
    { check: "provider", message: "Minis: Claude not signed in" },
  ],
  resume: true,
  runEnding: "active",
};

function ModelPickerStub() {
  return (
    <button
      type="button"
      className="inline-flex h-8 w-fit items-center gap-2 rounded-md border border-input px-3 text-sm"
    >
      Claude · Opus 5.5
    </button>
  );
}

function ThreadDialog() {
  const done = view === "thread-done";
  const ok = view === "thread-ready" || view === "thread-switch";
  const switching = view === "thread-switch";
  return (
    <HandOffThreadDialogView
      mode={switching ? "switch-model" : "move"}
      title="Fix the release build"
      destinations={destinations}
      destinationId={switching ? M4 : MINIS}
      onDestination={noop}
      modelSummary="Claude · Opus 5.5"
      modelPicker={<ModelPickerStub />}
      preflight={{
        state: "done",
        results: [ok ? { ...failing, ok: true, failures: [] } : failing],
      }}
      onRecheck={noop}
      submitting={false}
      error={null}
      result={
        done
          ? {
              machine: "Minis",
              value: {
                environmentId: MINIS,
                machineLabel: "Minis",
                threadId: tid("t-9"),
                modelSelection: null,
                notice: "Started with Opus 5.5; the turn that was running continues.",
              } as never,
            }
          : null
      }
      onSubmit={noop}
      onCancel={noop}
      onOpenContinuation={noop}
    />
  );
}

const threads = [
  { threadId: tid("a"), title: "Fix the release build" },
  { threadId: tid("b"), title: "Migrate settings storage" },
  { threadId: tid("c"), title: "Write the release notes" },
];
const run: HandoffMachineRun = {
  destinationEnvironmentId: MINIS,
  destinationLabel: "Minis",
  reason: "manual",
  startedAt: "2026-10-20T20:00:00.000Z",
  finishedAt: "2026-10-20T20:00:05.000Z",
  results: [
    {
      threadId: tid("a"),
      title: "Fix the release build",
      outcome: "moved",
      detail: null,
      continuedThreadId: tid("a2"),
      resumed: true,
    },
    {
      threadId: tid("b"),
      title: "Migrate settings storage",
      outcome: "stayed",
      detail: "Minis: no .env.local",
      continuedThreadId: null,
      resumed: false,
    },
    {
      threadId: tid("c"),
      title: "Write the release notes",
      outcome: "skipped",
      detail: "You left it out.",
      continuedThreadId: null,
      resumed: false,
    },
  ],
} as HandoffMachineRun;

function MachineDialog() {
  return (
    <HandOffMachineDialogView
      machineName="M4"
      projectName={view === "migrate" ? "atlas" : null}
      destinations={destinations.filter((item) => item.state !== "this-machine")}
      destinationId={MINIS}
      onDestination={noop}
      threads={threads}
      selected={new Set([tid("a"), tid("b")])}
      onToggle={noop}
      checking={false}
      preflight={
        new Map([
          [tid("a"), { ...failing, threadId: tid("a"), ok: true, failures: [] }],
          [tid("b"), { ...failing, threadId: tid("b"), failures: [failing.failures[0]!] }],
        ])
      }
      preflightError={null}
      submitting={false}
      error={null}
      run={view === "machine-done" ? run : null}
      destinationName="Minis"
      onSubmit={noop}
      onCancel={noop}
      onOpenThread={noop}
    />
  );
}

function ResumeConfirm() {
  return <ResumeMachineDialogView open onOpenChange={noop} onConfirm={noop} />;
}

const snapshot = (
  environmentId: EnvironmentId,
  projectModes: Record<string, "on" | "off"> = {},
) => ({
  environmentId,
  machineLabel: "M4",
  config: { ...DEFAULT_HANDOFF_CONFIG, sleepTarget: M3 },
  projectModes,
  threads: [],
  incoming: [],
  pausedSince: null,
  machineRun: null,
});

// Settings > Machines: one default, overrides listed only when a project has one.
function MachineSettings() {
  return (
    <HandoffModeSettingsView
      snapshot={snapshot(M4)}
      destinations={destinations.filter((item) => item.state !== "this-machine")}
      overrides={
        view === "settings-overrides"
          ? [
              { id: "p1" as ProjectId, title: "EasyChamp", mode: "on" },
              { id: "p2" as ProjectId, title: "Old app", archived: true, mode: "off" },
            ]
          : []
      }
      pending={false}
      error={null}
      onConfig={noop}
      onProjectMode={noop}
      onHandOffMachine={noop}
    />
  );
}

// Settings > Project: one choice for the project across its machines.
function ProjectSettings() {
  return (
    <ProjectHandoffModeSettingsView
      members={[
        { environmentId: M4, id: "p1" as ProjectId, snapshot: snapshot(M4, { p1: "on" }) },
        { environmentId: MINIS, id: "p9" as ProjectId, snapshot: snapshot(MINIS, { p9: "on" }) },
      ]}
      linked
      label={(id) => (id === M4 ? "M4" : "Minis")}
      pending={false}
      error={null}
      onChange={noop}
    />
  );
}

/**
 * The coordinator column as ProjectWorkspaceSurface lays it out (a display: contents wrapper
 * inside .sws-coordinator), with the "Continued from another machine" banner's history open
 * over a long conversation: the banner must stop at 40% of the column and scroll inside.
 * The banner's markup mirrors ProjectExecutionHistory; its data hooks need a live server.
 */
function CoordinatorBanner() {
  const turns = Array.from({ length: 14 }, (_, index) => index);
  return (
    <div
      className="project-surface"
      style={{ height: "100dvh", display: "flex", flexDirection: "column" }}
    >
      <div className="project-workspace-columns sws-columns" data-overview="closed">
        <section
          className="project-coordinator sws-coordinator"
          aria-label="Project coordinator"
          data-testid="coordinator"
        >
          <div className="contents">
            <section
              className="project-notice"
              data-slot="handoff-history"
              aria-label="Coordinator handoff history"
            >
              <p>
                Continued from another machine. This session started fresh with the retained
                messages, project context and a committed Git checkpoint.
              </p>
              <details open>
                <summary>Previous coordinator on M4 · Read only</summary>
                <div aria-label="Retained coordinator messages on M4">
                  {turns.map((turn) => (
                    <article key={turn} className="project-message">
                      <h3>{turn % 2 ? "Coordinator" : "You"}</h3>
                      <p>Retained message {turn + 1} from the coordinator on M4.</p>
                    </article>
                  ))}
                </div>
              </details>
            </section>
            <div className="project-conversation" data-testid="conversation">
              {turns.map((turn) => (
                <article
                  key={turn}
                  className={`project-message ${turn % 2 ? "project-message-assistant" : "project-message-user"}`}
                >
                  <p>{turn === 0 ? "First message on Minis" : `Message ${turn + 1} on Minis`}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Fixture() {
  if (view === "coordinator-banner") return <CoordinatorBanner />;
  return (
    <main className="min-h-screen bg-background p-4 text-foreground" data-testid="fixture">
      {view === "badges" ? <Badges /> : null}
      {view.startsWith("thread") ? <ThreadDialog /> : null}
      {view === "resume" ? <ResumeConfirm /> : null}
      {view.startsWith("settings") ? <MachineSettings /> : null}
      {view === "project" ? <ProjectSettings /> : null}
      {view.startsWith("machine") || view === "migrate" ? <MachineDialog /> : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
