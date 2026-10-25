import { createRoot } from "react-dom/client";
import * as DateTime from "effect/DateTime";
import { QueuedRunsControl } from "../../src/components/chat/QueuedRunsControl";
import { StripFixture } from "./strip";
import "./fixture.css";

// Views of the real queue drawer over real queue derivation (1048 AC-09, AC-10).
const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "busy";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const at = (minutesAgo: number) => DateTime.subtract(DateTime.nowUnsafe(), { minutes: minutesAgo });
const capabilities = (steer: boolean) => ({
  turns: {
    supportsQueuedMessages: true,
    supportsActiveSteering: steer,
    supportsSteeringByInterruptRestart: false,
  },
});

const senders = [
  ["thread:settings", "1031 Simplify settings across machines"],
  ["thread:release", "Release macOS app"],
  ["thread:review", "Fresh review of 1047 patch"],
  ["thread:sweep", "Completion sweep"],
] as const;

type Row = {
  readonly id: string;
  readonly text: string;
  readonly sender?: string;
  readonly createdBy?: "user" | "agent";
  readonly automatic?: "delegated" | "notification";
  readonly minutesAgo: number;
};

function projection(input: {
  readonly active: "steerable" | "no-turn" | "none";
  readonly last?: "interrupted" | "failed" | "usage_limit";
  readonly held?: boolean;
  readonly rows: ReadonlyArray<Row>;
}) {
  const runs: Array<Record<string, unknown>> = [];
  const turnItems: Array<Record<string, unknown>> = [];
  if (input.active !== "none") {
    runs.push({
      id: "run:active",
      status: "running",
      ordinal: 1,
      providerThreadId: "provider-thread",
      activeAttemptId: "attempt:active",
      rootNodeId: "node:active",
      requestedAt: at(148),
      startedAt: at(148),
      completedAt: null,
    });
  }
  if (input.last !== undefined) {
    runs.push({
      id: "run:last",
      status: input.last === "interrupted" ? "interrupted" : "failed",
      ordinal: 1,
      providerThreadId: "provider-thread",
      activeAttemptId: "attempt:last",
      rootNodeId: "node:last",
      requestedAt: at(150),
      startedAt: at(150),
      completedAt: at(20),
    });
    if (input.last !== "interrupted") {
      turnItems.push({
        id: "item:error",
        runId: "run:last",
        nodeId: "node:last",
        type: "error",
        status: "failed",
        ordinal: 9,
        updatedAt: at(20),
        failure:
          input.last === "usage_limit"
            ? { class: "usage_limit", message: "You've hit your usage limit." }
            : { class: "provider_error", message: "The provider closed the stream." },
      });
    }
  }
  const messages = input.rows.map((row) => ({
    id: `message:${row.id}`,
    runId: `run:${row.id}`,
    text: row.text,
    attachments: [],
    createdBy: row.createdBy ?? (row.sender ? "agent" : "user"),
    ...(row.sender ? { senderThreadId: row.sender } : {}),
    ...(row.automatic === "delegated"
      ? { delegatedCompletion: { parentRunId: "run:active", generation: 1, taskIds: ["t"] } }
      : {}),
    ...(row.automatic === "notification"
      ? {
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: row.text,
          },
        }
      : {}),
  }));
  input.rows.forEach((row, index) =>
    runs.push({
      id: `run:${row.id}`,
      status: "queued",
      ordinal: index + 2,
      queuePosition: index + 1,
      userMessageId: `message:${row.id}`,
      requestedAt: at(row.minutesAgo),
      ...(input.held ? { queueHeld: true } : {}),
    }),
  );
  return {
    thread: {
      id: "thread:coordinator",
      activeProviderThreadId: "provider-thread",
      providerInstanceId: "claude",
    },
    runs,
    messages,
    turnItems,
    providerTurns:
      input.active === "steerable"
        ? [{ id: "turn:active", runAttemptId: "attempt:active", status: "running" }]
        : [],
    providerThreads: [
      { id: "provider-thread", appThreadId: "thread:coordinator", providerSessionId: "session" },
    ],
    providerSessions: [
      {
        id: "session",
        providerInstanceId: "claude",
        status: "running",
        lastError: null,
        capabilities: capabilities(true),
      },
    ],
  };
}

const agentRows: ReadonlyArray<Row> = Array.from({ length: 13 }, (_, index) => ({
  id: `agent-${index}`,
  text: [
    "## Outcome\n\nSettings 12/12 pass; harnesses next.",
    "Release candidate built and notarized; waiting on review.",
    "Verdict: the patch needs one more fix in the resume path.",
    "Sweep finished 4 of 6 threads; two still running.",
  ][index % 4]!,
  sender: senders[index % senders.length]![0],
  minutesAgo: 140 - index * 9,
}));

const busyRows: ReadonlyArray<Row> = [
  {
    id: "result",
    text: "A delegated task reached a terminal state.",
    automatic: "delegated",
    minutesAgo: 3,
  },
  {
    id: "report",
    text: "Settings 12/12 pass; harnesses next.",
    sender: "thread:settings",
    minutesAgo: 12,
  },
  {
    id: "mine",
    text: "Then update the changelog and open the PR.",
    createdBy: "user",
    minutesAgo: 2,
  },
  {
    id: "monitor",
    text: "Monitor: build is green on main",
    automatic: "notification",
    minutesAgo: 1,
  },
];

const views: Record<
  string,
  {
    readonly projection: unknown;
    readonly results?: Record<string, unknown>;
    readonly unavailable?: string;
  }
> = {
  busy: { projection: projection({ active: "steerable", rows: busyRows }) },
  "not-steerable": { projection: projection({ active: "no-turn", rows: agentRows }) },
  stopped: {
    projection: projection({
      active: "none",
      last: "interrupted",
      held: true,
      rows: busyRows.slice(1, 3),
    }),
  },
  failure: {
    projection: projection({
      active: "none",
      last: "failed",
      held: true,
      rows: busyRows.slice(1, 3),
    }),
  },
  "usage-limit": {
    projection: projection({
      active: "none",
      last: "usage_limit",
      held: true,
      rows: busyRows.slice(1, 3),
    }),
  },
  refusal: {
    projection: projection({ active: "steerable", rows: busyRows.slice(1, 3) }),
    results: {
      promote: {
        _tag: "Failure",
        error: { message: "Provider session provider-session:claude:7f3 is not active." },
      },
    },
  },
  disconnected: {
    projection: projection({ active: "steerable", rows: busyRows.slice(1, 3) }),
    unavailable: "Anton's Mac mini is not connected.",
  },
};
const selected = views[view] ?? views.busy!;
window.calls = [];
window.fixture = {
  projection: selected.projection,
  titles: Object.fromEntries(senders),
  results: selected.results ?? {},
};

createRoot(document.getElementById("root")!).render(
  view.startsWith("strip-") ? (
    <StripFixture view={view} />
  ) : (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end bg-background p-3 text-foreground">
      <div className="rounded-xl border border-border bg-card">
        <QueuedRunsControl
          environmentId={"environment:m4" as never}
          threadId={"thread:coordinator" as never}
          optimisticMessages={[]}
          editingRunId={null}
          onEditQueuedRun={() => undefined}
          onCancelEdit={() => undefined}
          onResumeHeld={() => undefined}
          actionsUnavailableReason={selected.unavailable ?? null}
        />
        <div className="border-t border-border px-3 py-4 text-sm text-muted-foreground">
          Message the coordinator…
        </div>
      </div>
    </div>
  ),
);
