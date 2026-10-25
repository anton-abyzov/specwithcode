import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { deriveProviderSubagentStatus } from "@specweave-studio/client-runtime/state/thread-execution";
import * as DateTime from "effect/DateTime";
import { createRoot } from "react-dom/client";

import { ProviderSubagentBar } from "../../src/components/chat/ProviderSubagentBar";
import { SubagentsChip } from "../../src/components/studio/shell/SubagentsChip";
import { buildThreadPaneGroups, threadStatusWord } from "../../src/studio/shellModel";
import {
  runningSubagentCount,
  subagentEntryLabel,
  subagentStatusTone,
  threadSubagentEntries,
  withRunningSubagents,
} from "../../src/studio/threadSubagents";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

// The October 24 screenshot parents after 1053 (AC-06): records settled by
// T-02/T-03, child roots still left running where the incident left them.
const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const ENV = "m4";
const COORDINATOR = "project-coordinator:ec";
const UNREACHABLE = new Set(["m3"]);
const at = (minutesAgo: number) => DateTime.subtract(DateTime.nowUnsafe(), { minutes: minutesAgo });
const iso = (minutesAgo: number) => DateTime.formatIso(at(minutesAgo));

type Status = "running" | "completed" | "failed" | "cancelled" | "interrupted";
type Child = {
  readonly id: string;
  readonly title: string;
  readonly record: Status;
  /** What the child's own runless root or run still says. */
  readonly root: Status;
  readonly origin?: "provider_native" | "app_owned";
  readonly machine?: string;
  readonly result?: string;
};
type Parent = {
  readonly id: string;
  readonly title: string;
  readonly children: Child[];
  /** The parent's own turn still runs. */
  readonly working?: boolean;
};

const parents: Parent[] = [
  {
    id: "seo",
    title: "Daily SEO watch",
    children: [
      {
        id: "seo-2",
        title: "Daily SEO subagent 2",
        record: "completed",
        root: "running",
        result: "155 PR tests and 580 related tests pass",
      },
      {
        id: "seo-tenant",
        title: "Arena tenant 503/404 SEO fixes",
        record: "failed",
        root: "running",
        result: "Session limit reached (HTTP 429)",
      },
      {
        id: "seo-calendar",
        title: "Arena calendar soft-404 + Event endDate",
        record: "failed",
        root: "running",
        result: "Session limit reached (HTTP 429)",
      },
      {
        id: "seo-gsc",
        title: "verified-skill.com GSC fixes",
        record: "failed",
        root: "running",
        result: "Session limit reached (HTTP 429)",
      },
    ],
  },
  {
    id: "cms",
    title: "Remove sync unverified badge from CMS",
    children: [
      {
        id: "cms-audit",
        title: "ps23 canonical audit",
        record: "completed",
        root: "running",
        result: "Audit complete",
      },
    ],
  },
  {
    id: "console",
    title: "Console, Arena, UIKit feature PRs",
    children: [
      {
        id: "light",
        title: "Independent review light theme PR",
        record: "completed",
        root: "running",
        result: "SHIP: both medium findings fixed",
      },
    ],
  },
  {
    id: "club",
    title: "Club payment confirmation emails",
    children: [
      {
        id: "pr-491",
        title: "Final review PR 491 head",
        record: "completed",
        root: "running",
        result: "Clean review, 595 tests pass",
      },
      {
        id: "pr-492",
        title: "Final review PR 492 head",
        record: "completed",
        root: "running",
        result: "Clean review, 21 tests pass",
      },
    ],
  },
  {
    id: "premierliga",
    title: "0952 PremierLiga import unblock",
    children: [
      {
        id: "winter",
        title: "Audit who created duplicate Winter",
        record: "interrupted",
        root: "interrupted",
      },
    ],
  },
  {
    id: "stopped",
    title: "Stopped by you",
    children: [
      {
        id: "stop-child",
        title: "Rebuild the seed data",
        record: "cancelled",
        root: "cancelled",
        origin: "app_owned",
      },
    ],
  },
  {
    id: "remote",
    title: "Review on another machine",
    children: [
      {
        id: "remote-child",
        title: "Cross-check fixtures on M3",
        record: "running",
        root: "running",
        origin: "app_owned",
        machine: "m3",
      },
    ],
  },
  {
    // Opened from cached detail: the native child's root still runs and its host is away.
    id: "remote-native",
    title: "Native review on another machine",
    children: [
      {
        id: "remote-native-child",
        title: "Native schema audit on M3",
        record: "running",
        root: "running",
        machine: "m3",
      },
    ],
  },
  {
    // r5 F3: the parent works on; one native child's receipt closed its root.
    id: "working-parent",
    title: "Parent still working",
    working: true,
    children: [
      {
        id: "receipt-done",
        title: "Native review that finished",
        record: "completed",
        root: "completed",
        result: "SHIP",
      },
      {
        id: "native-working",
        title: "Native test run still going",
        record: "running",
        root: "running",
      },
    ],
  },
  {
    id: "live",
    title: "Live delegated review",
    children: [
      {
        id: "delegated",
        title: "Delegated accessibility review",
        record: "running",
        root: "running",
        origin: "app_owned",
      },
    ],
  },
];

const live = (status: Status) => status === "running";

function shell(
  id: string,
  parent: string | null,
  title: string,
  child?: Child,
  working = false,
): EnvironmentThreadShell {
  return {
    environmentId: ENV,
    id,
    projectId: "ec",
    title,
    createdBy: "agent",
    deletedAt: null,
    archivedAt: null,
    settledOverride: null,
    createdAt: iso(600),
    updatedAt: iso(540),
    latestUserMessageAt: iso(600),
    lineage: {
      parentThreadId: parent,
      relationshipToParent: parent === null ? null : "subagent",
      rootThreadId: COORDINATOR,
    },
    forkedFrom: null,
    movedTo: null,
    movedFrom: null,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    providerInstanceId: "claudeAgent",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    runtime:
      working || (child !== undefined && live(child.root))
        ? {
            status: "running",
            activeRunId: null,
            providerInstanceId: "claudeAgent",
            providerName: null,
            lastError: null,
            updatedAt: iso(540),
          }
        : null,
    latestRun:
      child === undefined
        ? {
            runId: `run:${id}`,
            status: working ? "running" : "completed",
            requestedAt: iso(560),
            startedAt: iso(560),
            completedAt: working ? null : iso(540),
            assistantMessageId: null,
          }
        : child.origin === "app_owned" && !live(child.root)
          ? {
              runId: `run:${id}`,
              status: child.root,
              requestedAt: iso(560),
              startedAt: iso(560),
              completedAt: iso(540),
              assistantMessageId: null,
            }
          : null,
    // The parent's records arrive later; a native child is known by its creation source.
    source: {
      creationSource:
        child !== undefined && (child.origin ?? "provider_native") === "provider_native"
          ? "provider"
          : "mcp",
    },
    ...(child?.machine === undefined
      ? {}
      : { executionMachineId: child.machine, executionState: "running" }),
  } as unknown as EnvironmentThreadShell;
}

const record = (parent: Parent, child: Child) => ({
  id: `node:${child.id}`,
  threadId: parent.id,
  childThreadId: child.id,
  title: child.title,
  prompt: `Review ${child.title}`,
  status: child.record,
  origin: child.origin ?? "provider_native",
  providerInstanceId: "claudeAgent",
  model: "claude-opus-5-5",
  result: child.result ?? null,
  startedAt: at(600),
  completedAt: live(child.record) ? null : at(590),
});

// The native child's own projection: a runless root turn, as the peek's bar reads it.
const childProjection = (child: Child) =>
  ({
    thread: {
      id: child.id,
      creationSource: "provider",
      lineage: { parentThreadId: "p", relationshipToParent: "subagent", rootThreadId: COORDINATOR },
    },
    nodes: [
      {
        kind: "root_turn",
        runId: null,
        status: child.root,
        startedAt: at(600),
        completedAt: live(child.root) ? null : at(590),
      },
    ],
  }) as never;

const shells: EnvironmentThreadShell[] = [shell(COORDINATOR, null, "Coordinator")];
for (const parent of parents) {
  shells.push(shell(parent.id, COORDINATOR, parent.title, undefined, parent.working));
  for (const child of parent.children) shells.push(shell(child.id, parent.id, child.title, child));
}
const workers = shells.filter((thread) => thread.lineage.parentThreadId === COORDINATOR);
const projectedOf = (parent: Parent) =>
  parent.children.map((child) => record(parent, child)) as never;
const counts = new Map(
  parents.map((parent) => [
    `${ENV}:${parent.id}`,
    runningSubagentCount(
      shells,
      shell(parent.id, COORDINATOR, parent.title, undefined, parent.working),
      undefined,
      projectedOf(parent),
      UNREACHABLE,
    ),
  ]),
);
// An unopened row counts from shells alone; it must agree with the open row.
const unopenedCounts = new Map(
  parents.map((parent) => [
    `${ENV}:${parent.id}`,
    runningSubagentCount(
      shells,
      shell(parent.id, COORDINATOR, parent.title, undefined, parent.working),
      undefined,
      [],
      UNREACHABLE,
    ),
  ]),
);
const groups = buildThreadPaneGroups(workers, "title", "", counts, new Set());
const shellOf = (id: string) => shells.find((candidate) => candidate.id === id) ?? null;

function Row({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const parent = parents.find((candidate) => candidate.id === thread.id)!;
  const entries = threadSubagentEntries({
    parent: thread,
    shells,
    projected: projectedOf(parent),
    unreachable: UNREACHABLE,
  });
  const working = counts.get(`${ENV}:${thread.id}`) ?? 0;
  const word = withRunningSubagents(threadStatusWord(thread), working);
  const tone = working > 0 ? "working" : "idle";
  return (
    <article
      className="overflow-hidden rounded-lg border border-border bg-card"
      data-row={thread.id}
      data-tone={tone}
      data-count={working}
      data-unopened-count={unopenedCounts.get(`${ENV}:${thread.id}`) ?? 0}
    >
      <div className="sws-thread-row flex items-start gap-3 p-3">
        <span className="sws-dot mt-1.5" data-tone={working > 0 ? tone : "none"} aria-hidden />
        <span className="sws-thread-text min-w-0 flex-1">
          <strong>{thread.title}</strong>
          <span className="sws-thread-meta">
            <span className="sws-thread-status" data-row-word data-tone={tone}>
              {word ?? "Idle"}
            </span>
          </span>
        </span>
        <span data-chip={thread.id}>
          <SubagentsChip environmentId={ENV} entries={entries} onPeek={() => {}} />
        </span>
      </div>
      <ul className="flex flex-col gap-2 border-t border-border px-3 py-2 ps-8" aria-label="Peeks">
        {entries.map((entry) => {
          const child = parent.children.find((candidate) => candidate.id === entry.childThreadId)!;
          const native = (child.origin ?? "provider_native") === "provider_native";
          const peekTone = subagentStatusTone(entry.status);
          return (
            <li key={entry.key} className="flex min-w-0 flex-col gap-1" data-peek={entry.key}>
              <span className="sws-subagent-meta flex-wrap">
                <span className="sws-subagent-title text-foreground">{entry.title}</span>
                <span className="sws-subagent-status" data-tone={peekTone} data-peek-label>
                  <span className="sws-dot" data-tone={peekTone} aria-hidden />
                  {subagentEntryLabel(entry)}
                </span>
              </span>
              {native ? (
                <span data-bar>
                  <ProviderSubagentBar
                    provider={null}
                    showInstanceBadge={false}
                    modelLabel="Opus 5.5"
                    effortLabel={null}
                    status={deriveProviderSubagentStatus(
                      childProjection(child),
                      projectedOf(parent),
                      {
                        thread: shellOf(child.id),
                        parent: shellOf(parent.id),
                        unreachable: UNREACHABLE,
                      },
                    )}
                    onOpenParent={null}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function Fixture() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4" data-fixture>
      <header>
        <h1 className="text-lg font-semibold">EasyChamp threads after 1053</h1>
        <p className="text-sm text-muted-foreground">
          Working only while a turn or a child really runs. A terminal record outranks a stale child
          root.
        </p>
      </header>
      {groups
        .filter((group) => group.threads.length > 0)
        .map((group) => (
          <section key={group.group} className="flex flex-col gap-2" data-group={group.group}>
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.group} · {group.threads.length}
            </h2>
            {group.threads.map((thread) => (
              <Row key={thread.id} thread={thread} />
            ))}
          </section>
        ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
