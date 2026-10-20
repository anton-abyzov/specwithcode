import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  buildChatGroups,
  buildThreadPaneGroups,
  chatListEmptyMessage,
  chatListOptionsAreDefault,
  compactAge,
  dateBucket,
  DEFAULT_CHAT_LIST_OPTIONS,
  isOrchestratorThreadId,
  modelLabel,
  nowFromMinute,
  parseChatListOptions,
  parseThreadSort,
  providerShortLabel,
  shortMachineName,
  shortModelName,
  threadsSummary,
  threadStatusWord,
  threadTone,
  waitingCount,
} from "./shellModel";
import { unreachableEnvironmentIds } from "../state/environments";

type ThreadOverrides = Omit<Partial<EnvironmentThreadShell>, "id"> & { id?: string };
function thread(overrides: ThreadOverrides = {}): EnvironmentThreadShell {
  return {
    id: "worker-1",
    environmentId: "host-1",
    projectId: "project-1",
    title: "Worker",
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
    modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    ...overrides,
  } as EnvironmentThreadShell;
}
const running = { status: "running" } as EnvironmentThreadShell["runtime"];
const failed = { status: "failed", lastErrorClass: null } as EnvironmentThreadShell["runtime"];
// Local noon, so calendar-day buckets do not depend on the runner's time zone.
const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
const at = (daysAgo: number, hour = 9) =>
  new Date(2026, 9, 10 - daysAgo, 0, Math.round(hour * 60), 0).toISOString();
const projectLabel = (t: EnvironmentThreadShell) => String(t.projectId);

describe("machine names", () => {
  it("drops the owner so a row keeps room for the model", () => {
    expect(shortMachineName("Anton's MacBook M4MAX (149)")).toBe("MacBook M4MAX (149)");
    expect(shortMachineName("Anton’s Mac mini")).toBe("Mac mini");
    expect(shortMachineName("build-box")).toBe("build-box");
    expect(shortMachineName("Anton's ")).toBe("Anton's");
  });
});

describe("model and provider names", () => {
  it("says a model the way people do", () => {
    expect(shortModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModelName("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(shortModelName("claude-3-5-sonnet-latest")).toBe("Sonnet 3.5");
    expect(shortModelName("gpt-6-astra")).toBe("GPT-6 Astra");
    expect(shortModelName("gpt-5.2-codex")).toBe("GPT-5.2 Codex");
    expect(shortModelName("grok-code-fast-2")).toBe("Grok Code Fast 2");
    expect(shortModelName("openrouter/gemini-3-pro-preview")).toBe("Gemini 3 Pro");
    expect(shortModelName("  ")).toBe("Model not set");
  });
  it("names the agent behind a registry instance, never the transport", () => {
    expect(
      providerShortLabel(
        { driverKind: "acpRegistry", displayName: "GitHub Copilot", acpRegistryAgentId: "copilot" },
        "acp-1",
      ),
    ).toBe("Copilot");
    expect(providerShortLabel({ driverKind: "claudeAgent", displayName: "Work" }, "work")).toBe(
      "Claude Code",
    );
    expect(providerShortLabel({ driverKind: "codex", displayName: "Codex 2" }, "codex2")).toBe(
      "Codex",
    );
  });
  it("still names a provider whose host has not answered yet", () => {
    expect(providerShortLabel(null, "claudeAgent")).toBe("Claude Code");
    expect(providerShortLabel(null, "grok")).toBe("Grok");
    expect(providerShortLabel(null, "team-a")).toBe("team-a");
  });
  it("does not say the provider twice", () => {
    const claude = {
      driverKind: "claudeAgent",
      displayName: "Claude",
      models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }],
    };
    expect(modelLabel(claude, "claudeAgent", "claude-opus-5-5")).toEqual({
      provider: "Claude Code",
      model: "Opus 5.5",
      full: "Claude Code · Opus 5.5",
    });
    expect(modelLabel(null, "grok", "grok-code-fast-2").model).toBe("Code Fast 2");
    expect(modelLabel(null, "codex", "gpt-6-astra").full).toBe("Codex · GPT-6 Astra");
    // A model named only for its provider keeps its name.
    expect(modelLabel(null, "grok", "grok").model).toBe("Grok");
    expect(modelLabel(null, "grok", "grok-5")).toEqual({
      provider: "Grok",
      model: "Grok 5",
      full: "Grok 5",
    });
  });
  it("names the harness apart from the model's maker", () => {
    const copilot = {
      driverKind: "acpRegistry",
      displayName: "GitHub Copilot",
      acpRegistryAgentId: "copilot",
      models: [{ slug: "claude-opus-5.5", name: "Claude Opus 5.5" }],
    };
    expect(modelLabel(copilot, "copilot-0889", "claude-opus-5.5")).toEqual({
      provider: "Copilot",
      model: "Claude Opus 5.5",
      full: "Copilot · Claude Opus 5.5",
    });
    // Before the host's catalogue answers, the slug alone still names the maker.
    expect(modelLabel(null, "copilot-0889", "claude-opus-5.5").full).toBe(
      "Copilot · Claude Opus 5.5",
    );
    expect(modelLabel(null, "claudeAgent", "claude-opus-5-5").full).toBe("Claude Code · Opus 5.5");
  });
});

describe("chats in the sidebar", () => {
  it("buckets by the viewer's calendar days", () => {
    expect(dateBucket(at(0, 1), now)).toBe("Today");
    expect(dateBucket(at(1, 23), now)).toBe("Yesterday");
    expect(dateBucket(at(7), now)).toBe("Previous 7 days");
    expect(dateBucket(at(8), now)).toBe("Previous 30 days");
    expect(dateBucket(at(31), now)).toBe("Older");
    expect(dateBucket("not a date", now)).toBe("Older");
  });
  it("lists chats under date headings, newest first, without empty headings", () => {
    const groups = buildChatGroups(
      [
        thread({ id: "a", createdAt: at(0, 8) }),
        thread({ id: "b", createdAt: at(0, 10) }),
        thread({ id: "c", createdAt: at(3) }),
        thread({ id: "d", createdAt: at(40) }),
      ],
      DEFAULT_CHAT_LIST_OPTIONS,
      { now, projectLabel },
    );
    expect(groups.map((g) => [g.label, g.threads.map((t) => t.id)])).toEqual([
      ["Today", ["b", "a"]],
      ["Previous 7 days", ["c"]],
      ["Older", ["d"]],
    ]);
  });
  it("never lists an orchestrator, an archived or a deleted session", () => {
    const groups = buildChatGroups(
      [
        thread({ id: "project-coordinator:p1" }),
        thread({ id: "gone", deletedAt: at(0) }),
        thread({ id: "stored", archivedAt: at(0) }),
        thread({ id: "kept" }),
      ],
      { ...DEFAULT_CHAT_LIST_OPTIONS, status: "all", groupBy: "none" },
      { now, projectLabel },
    );
    expect(groups.flatMap((g) => g.threads.map((t) => t.id))).toEqual(["kept"]);
    expect(isOrchestratorThreadId("project-coordinator:p1")).toBe(true);
    expect(isOrchestratorThreadId("worker-1")).toBe(false);
  });
  it("filters by status, recency and title", () => {
    const rows = [
      thread({ id: "ask", hasPendingUserInput: true, createdAt: at(0), title: "Deploy fix" }),
      thread({ id: "done", settledOverride: "settled", createdAt: at(0), title: "Old deploy" }),
      thread({ id: "stale", createdAt: at(20), title: "Deploy notes" }),
    ];
    const ids = (options: Parameters<typeof buildChatGroups>[1], query?: string) =>
      buildChatGroups(
        rows,
        { ...options, groupBy: "none" },
        { now, projectLabel, ...(query === undefined ? {} : { query }) },
      ).flatMap((g) => g.threads.map((t) => t.id));
    expect(ids(DEFAULT_CHAT_LIST_OPTIONS)).toEqual(["ask", "stale"]);
    expect(ids({ ...DEFAULT_CHAT_LIST_OPTIONS, status: "waiting" })).toEqual(["ask"]);
    expect(ids({ ...DEFAULT_CHAT_LIST_OPTIONS, status: "resolved" })).toEqual(["done"]);
    expect(ids({ ...DEFAULT_CHAT_LIST_OPTIONS, status: "all", activity: "7d" })).toEqual([
      "ask",
      "done",
    ]);
    expect(ids({ ...DEFAULT_CHAT_LIST_OPTIONS, status: "all" }, "NOTES")).toEqual(["stale"]);
  });
  it("groups by project in name order and by status in attention order", () => {
    const rows = [
      thread({ id: "z", projectId: "zeta" as never }),
      thread({ id: "a", projectId: "alpha" as never, runtime: running }),
      thread({ id: "w", projectId: "alpha" as never, hasPendingApprovals: true }),
    ];
    expect(
      buildChatGroups(
        rows,
        { ...DEFAULT_CHAT_LIST_OPTIONS, groupBy: "project" },
        {
          now,
          projectLabel,
        },
      ).map((g) => g.label),
    ).toEqual(["alpha", "zeta"]);
    expect(
      buildChatGroups(
        rows,
        { ...DEFAULT_CHAT_LIST_OPTIONS, groupBy: "status" },
        {
          now,
          projectLabel,
        },
      ).map((g) => g.label),
    ).toEqual(["Waiting on you", "Working", "Idle"]);
  });
  it("sorts by name or creation when asked", () => {
    const rows = [
      thread({ id: "1", title: "beta 10", createdAt: at(5) }),
      thread({ id: "2", title: "Alpha", createdAt: at(1) }),
      thread({ id: "3", title: "beta 2", createdAt: at(9) }),
    ];
    const ids = (sortBy: "title" | "created") =>
      buildChatGroups(
        rows,
        { ...DEFAULT_CHAT_LIST_OPTIONS, groupBy: "none", sortBy },
        {
          now,
          projectLabel,
        },
      )[0]!.threads.map((t) => t.id);
    expect(ids("title")).toEqual(["2", "3", "1"]);
    expect(ids("created")).toEqual(["2", "1", "3"]);
  });
  it("keeps a subagent's own thread out of the chat list", () => {
    const rows = [
      thread({ id: "chat" }),
      thread({
        id: "helper",
        lineage: { relationshipToParent: "subagent" } as EnvironmentThreadShell["lineage"],
      }),
    ];
    const groups = buildChatGroups(
      rows,
      { ...DEFAULT_CHAT_LIST_OPTIONS, groupBy: "none" },
      { now, projectLabel },
    );
    expect(groups.flatMap((group) => group.threads.map((t) => t.id))).toEqual(["chat"]);
  });
  it("leaves a project's own threads to the project unless asked to show them", () => {
    const rows = [
      thread({ id: "chat", createdAt: at(0, 9) }),
      thread({ id: "worker", projectId: "atlas" as never, createdAt: at(0, 10) }),
      thread({ id: "older", createdAt: at(3) }),
    ];
    const isProjectThread = (t: EnvironmentThreadShell) => t.projectId === "atlas";
    const view = (options: Parameters<typeof buildChatGroups>[1]) =>
      buildChatGroups(rows, options, { now, projectLabel, isProjectThread }).map((g) => [
        g.label,
        g.threads.map((t) => t.id),
      ]);
    expect(view(DEFAULT_CHAT_LIST_OPTIONS)).toEqual([
      ["Today", ["chat"]],
      ["Previous 7 days", ["older"]],
    ]);
    expect(view({ ...DEFAULT_CHAT_LIST_OPTIONS, projectThreads: "show" })).toEqual([
      ["Today", ["worker", "chat"]],
      ["Previous 7 days", ["older"]],
    ]);
    // Without a way to tell, every chat is a regular one.
    expect(
      buildChatGroups(rows, DEFAULT_CHAT_LIST_OPTIONS, { now, projectLabel }).flatMap((g) =>
        g.threads.map((t) => t.id),
      ),
    ).toEqual(["worker", "chat", "older"]);
    // A project's own threads hidden leaves no chats, and no empty heading either.
    expect(
      buildChatGroups([rows[1]!], DEFAULT_CHAT_LIST_OPTIONS, {
        now,
        projectLabel,
        isProjectThread,
      }),
    ).toEqual([]);
  });
  it("keeps busy chats in place through streamed items, tool calls and status changes", () => {
    // Three workers started this morning, the way delegated lanes appear.
    let rows = [
      thread({ id: "lane-a", title: "0949 Folder copy", createdAt: at(0, 8) }),
      thread({ id: "lane-b", title: "0948 Link projects", createdAt: at(0, 9) }),
      thread({ id: "lane-c", title: "0951 Machine grants", createdAt: at(0, 10) }),
      thread({ id: "quiet", title: "Current time", createdAt: at(1, 15) }),
    ];
    const view = () =>
      buildChatGroups(rows, DEFAULT_CHAT_LIST_OPTIONS, { now, projectLabel }).map((g) => [
        g.label,
        g.threads.map((t) => t.id),
      ]);
    const before = view();
    expect(before).toEqual([
      ["Today", ["lane-c", "lane-b", "lane-a"]],
      ["Yesterday", ["quiet"]],
    ]);
    // Interleaved server events: each one moves `updatedAt` forward on one row.
    const events: Array<[string, Partial<EnvironmentThreadShell>]> = [
      ["lane-a", { runtime: running, updatedAt: at(0, 11) }],
      ["lane-b", { updatedAt: at(0, 11.1) }],
      ["quiet", { runtime: running, updatedAt: at(0, 11.2) }],
      ["lane-a", { pendingBackgroundTasks: [{}] as never, updatedAt: at(0, 11.3) }],
      ["lane-c", { hasPendingApprovals: true, updatedAt: at(0, 11.4) }],
      ["lane-b", { runtime: failed, updatedAt: at(0, 11.5) }],
      ["lane-c", { hasPendingApprovals: false, runtime: null, updatedAt: at(0, 11.6) }],
    ];
    for (const [id, change] of events) {
      rows = rows.map((t) => (t.id === id ? { ...t, ...change } : t));
      expect(view()).toEqual(before);
    }
    // Nothing is frozen: the rows carry the newest state.
    const shown = buildChatGroups(rows, DEFAULT_CHAT_LIST_OPTIONS, { now, projectLabel })
      .flatMap((g) => g.threads)
      .find((t) => t.id === "lane-b");
    expect(shown?.runtime).toBe(failed);
  });
  it("moves a chat only when it is asked for work, and keeps ties in a fixed order", () => {
    const same = at(0, 9);
    let rows = [
      thread({ id: "b", createdAt: same }),
      thread({ id: "a", createdAt: same }),
      thread({ id: "c", createdAt: at(0, 8) }),
    ];
    const ids = () =>
      buildChatGroups(
        rows,
        { ...DEFAULT_CHAT_LIST_OPTIONS, groupBy: "none" },
        { now, projectLabel },
      )[0]!.threads.map((t) => t.id);
    expect(ids()).toEqual(["a", "b", "c"]);
    // Equal keys keep the id order whichever row the server sent last.
    rows = [rows[1]!, rows[2]!, { ...rows[0]!, updatedAt: at(0, 11) }];
    expect(ids()).toEqual(["a", "b", "c"]);
    // The person sends a message in the oldest chat: it comes to the top.
    rows = rows.map((t) => (t.id === "c" ? { ...t, latestUserMessageAt: at(0, 11.5) } : t));
    expect(ids()).toEqual(["c", "a", "b"]);
    // A coordinator hands "b" a new turn: that is new work, so it moves too.
    rows = rows.map((t) =>
      t.id === "b" ? { ...t, latestRun: { requestedAt: at(0, 11.7) } as never } : t,
    );
    expect(ids()).toEqual(["b", "c", "a"]);
    // A new chat starts on top.
    rows = [...rows, thread({ id: "new", createdAt: at(0, 11.9) })];
    expect(ids()).toEqual(["new", "b", "c", "a"]);
  });
  it("keeps a chat under its date heading and in the recency filter while it streams", () => {
    const rows = [
      thread({ id: "old", createdAt: at(20), updatedAt: at(0, 11), runtime: running }),
      thread({ id: "fresh", createdAt: at(0, 9) }),
    ];
    expect(
      buildChatGroups(rows, DEFAULT_CHAT_LIST_OPTIONS, { now, projectLabel }).map((g) => [
        g.label,
        g.threads.map((t) => t.id),
      ]),
    ).toEqual([
      ["Today", ["fresh"]],
      ["Previous 30 days", ["old"]],
    ]);
    expect(
      buildChatGroups(
        rows,
        { ...DEFAULT_CHAT_LIST_OPTIONS, activity: "7d", groupBy: "none" },
        { now, projectLabel },
      ).flatMap((g) => g.threads.map((t) => t.id)),
    ).toEqual(["fresh"]);
  });
  it("says where the chats went when only project threads are left out", () => {
    expect(chatListEmptyMessage(DEFAULT_CHAT_LIST_OPTIONS, 0)).toBe("No chats yet.");
    expect(chatListEmptyMessage(DEFAULT_CHAT_LIST_OPTIONS, 2)).toBe(
      "No chats yet. Threads agents started are on their project page.",
    );
    expect(chatListEmptyMessage({ ...DEFAULT_CHAT_LIST_OPTIONS, status: "waiting" }, 0)).toBe(
      "No chats match this filter.",
    );
    // Showing project threads already, nothing is hidden for that reason.
    expect(chatListEmptyMessage({ ...DEFAULT_CHAT_LIST_OPTIONS, projectThreads: "show" }, 3)).toBe(
      "No chats match this filter.",
    );
  });
  it("reads the shared minute clock as UTC, whatever zone the browser is in", () => {
    expect(nowFromMinute("2026-10-10T15:47")).toBe(Date.UTC(2026, 9, 10, 15, 47));
  });
  it("reads saved options defensively", () => {
    expect(parseChatListOptions(null)).toEqual(DEFAULT_CHAT_LIST_OPTIONS);
    expect(parseChatListOptions({ status: "resolved", groupBy: "nonsense", sortBy: 7 })).toEqual({
      ...DEFAULT_CHAT_LIST_OPTIONS,
      status: "resolved",
    });
    // Options saved before the project-thread choice existed keep their other picks.
    expect(
      parseChatListOptions({ status: "all", activity: "7d", groupBy: "none", sortBy: "title" }),
    ).toEqual({
      status: "all",
      activity: "7d",
      projectThreads: "hide",
      groupBy: "none",
      sortBy: "title",
    });
    expect(parseChatListOptions({ projectThreads: "show" }).projectThreads).toBe("show");
    expect(parseChatListOptions({ projectThreads: "maybe" }).projectThreads).toBe("hide");
    expect(chatListOptionsAreDefault(DEFAULT_CHAT_LIST_OPTIONS)).toBe(true);
    expect(
      chatListOptionsAreDefault({ ...DEFAULT_CHAT_LIST_OPTIONS, projectThreads: "show" }),
    ).toBe(false);
    expect(chatListOptionsAreDefault({ ...DEFAULT_CHAT_LIST_OPTIONS, groupBy: "project" })).toBe(
      false,
    );
  });
});

describe("a project's Threads pane", () => {
  const rows = [
    thread({ id: "idle-old", updatedAt: at(4), title: "b" }),
    thread({ id: "idle-new", updatedAt: at(0), title: "a" }),
    thread({ id: "busy", runtime: running }),
    thread({ id: "ask", hasPendingApprovals: true }),
    thread({ id: "done", settledOverride: "settled" }),
    thread({ id: "stored", archivedAt: at(0) }),
  ];
  it("orders the headings by who has to act", () => {
    expect(
      buildThreadPaneGroups(rows, "activity").map((g) => [g.group, g.threads.map((t) => t.id)]),
    ).toEqual([
      ["Waiting on you", ["ask"]],
      ["Working", ["busy"]],
      ["Idle", ["idle-new", "idle-old"]],
      ["Resolved", ["done", "stored"]],
    ]);
  });
  it("shows every lifecycle heading even when empty", () => {
    expect(buildThreadPaneGroups([thread()], "activity").map((g) => g.group)).toEqual([
      "Waiting on you",
      "Working",
      "Idle",
      "Resolved",
    ]);
  });
  it("sorts inside a heading by the chosen order and narrows by title", () => {
    const idle = (sort: Parameters<typeof buildThreadPaneGroups>[1], query?: string) =>
      buildThreadPaneGroups(rows, sort, query)
        .find((g) => g.group === "Idle")
        ?.threads.map((t) => t.id);
    expect(idle("title")).toEqual(["idle-new", "idle-old"]);
    expect(idle("activity", "B")).toEqual(["idle-old"]);
    const byModel = buildThreadPaneGroups(
      [
        thread({ id: "g", modelSelection: { instanceId: "grok", model: "grok-5" } as never }),
        thread({ id: "c", modelSelection: { instanceId: "claudeAgent", model: "x" } as never }),
      ],
      "model",
    ).find((g) => g.group === "Idle");
    expect(byModel?.threads.map((t) => t.id)).toEqual(["c", "g"]);
    expect(parseThreadSort("model")).toBe("model");
    expect(parseThreadSort("sideways")).toBe("activity");
  });
  it("keeps busy rows still while their turns stream, moving one only when it takes on new work", () => {
    const busy = (
      id: string,
      createdDaysAgo: number,
      askedDaysAgo: number,
      updatedDaysAgo: number,
    ) =>
      thread({
        id,
        runtime: running,
        createdAt: at(createdDaysAgo),
        updatedAt: at(updatedDaysAgo),
        latestRun: { requestedAt: at(askedDaysAgo) } as never,
      });
    const working = (rows: EnvironmentThreadShell[]) =>
      buildThreadPaneGroups(rows, "activity")
        .find((g) => g.group === "Working")
        ?.threads.map((t) => t.id);
    // a's turn started after b's; a streamed item updates b, which must not move it up.
    expect(working([busy("a", 9, 1, 1), busy("b", 9, 5, 0)])).toEqual(["a", "b"]);
    expect(working([busy("a", 9, 1, 1), busy("b", 9, 5, 1)])).toEqual(["a", "b"]);
    // A new turn on b is new work: b moves to the top.
    expect(working([busy("a", 9, 1, 1), busy("b", 9, 0, 0)])).toEqual(["b", "a"]);
  });
  it("summarises what needs the person first", () => {
    expect(waitingCount(rows)).toBe(1);
    expect(threadsSummary(rows)).toBe("1 thread is waiting on you · 1 working.");
    expect(
      threadsSummary([
        thread({ id: "a", hasPendingUserInput: true }),
        thread({ id: "b", hasPendingApprovals: true }),
      ]),
    ).toBe("2 threads are waiting on you.");
    expect(threadsSummary([thread()])).toBe("Nothing is waiting on you.");
    expect(threadsSummary([])).toBe("No threads yet. Ask the coordinator to start one.");
    // Workers on another machine are not threads here, but the project is not empty.
    expect(threadsSummary([], 1)).toBe("One worker runs on another machine.");
    expect(threadsSummary([], 2)).toBe("2 workers run on another machine.");
  });
  it("leads a row with a status word only when the thread wants something", () => {
    expect(threadStatusWord(thread({ hasPendingApprovals: true }))).toBe("Approval requested");
    expect(threadStatusWord(thread({ hasPendingUserInput: true }))).toBe("Answer needed");
    expect(threadStatusWord(thread())).toBeNull();
    expect(threadStatusWord(thread({ settledOverride: "settled" }))).toBeNull();
    // Held messages never start on their own, so the row says so and the dot asks.
    expect(threadStatusWord(thread({ heldQueuedCount: 3 }))).toBe("Queue held");
    expect(threadTone(thread({ heldQueuedCount: 3 }))).toBe("waiting");
  });
  it("gives each row one status tone", () => {
    expect(threadTone(thread({ hasPendingUserInput: true }))).toBe("waiting");
    expect(threadTone(thread({ runtime: failed }))).toBe("failed");
    expect(threadTone(thread({ runtime: running }))).toBe("working");
    expect(threadTone(thread({ settledOverride: "settled" }))).toBe("resolved");
    expect(threadTone(thread())).toBe("idle");
  });
  it("shortens ages for the last column", () => {
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(compactAge(ago(20_000), now)).toBe("now");
    expect(compactAge(ago(5 * 60_000), now)).toBe("5m");
    expect(compactAge(ago(3 * 3_600_000), now)).toBe("3h");
    expect(compactAge(ago(2 * 86_400_000), now)).toBe("2d");
    expect(compactAge(ago(21 * 86_400_000), now)).toBe("3w");
    expect(compactAge(ago(90 * 86_400_000), now)).toBe("3mo");
    expect(compactAge("nope", now)).toBe("");
  });
});

describe("resolved historical failures", () => {
  it.each(["usage_limit", "provider_error"])(
    "removes %s attention and status wording",
    (lastErrorClass) => {
      const resolved = thread({
        settledOverride: "settled",
        runtime: { status: "failed", lastErrorClass } as EnvironmentThreadShell["runtime"],
      });
      expect(waitingCount([resolved])).toBe(0);
      expect(threadTone(resolved)).toBe("resolved");
      expect(threadStatusWord(resolved)).toBeNull();
      expect(waitingCount([{ ...resolved, settledOverride: "active" }])).toBe(1);
    },
  );
});

describe("blocked threads", () => {
  const blocked = thread({ reportedBlocker: "Ship 1.0.20 today, or wait for the signer?" });

  it("names a quiet thread whose report has a blocker Blocked, waiting on you", () => {
    expect(threadStatusWord(blocked)).toBe("Blocked");
    expect(threadTone(blocked)).toBe("waiting");
  });

  it("drops the blocker while the thread runs again or once it is resolved", () => {
    expect(threadStatusWord({ ...blocked, runtime: running })).toBe("Working");
    expect(threadTone({ ...blocked, settledOverride: "settled" })).toBe("resolved");
    expect(threadStatusWord(thread({ reportedBlocker: null }))).toBeNull();
  });
});

describe("threads on this machine while its server catches up", () => {
  it("are never Host offline and still wait on the person", () => {
    const blocked = thread({ reportedBlocker: "Commit these changes, or discard them?" });
    const unreachable = new Set<string>(
      unreachableEnvironmentIds([
        {
          environmentId: blocked.environmentId,
          entry: {
            target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://127.0.0.1:8319" },
          },
          connection: { phase: "reconnecting" },
        },
        {
          environmentId: "m1",
          entry: { target: { _tag: "RelayConnectionTarget" } },
          connection: { phase: "reconnecting" },
        },
      ] as never),
    );
    expect([...unreachable]).toEqual(["m1"]);
    const hostOffline = unreachable.has(blocked.environmentId);
    expect(threadStatusWord(blocked, hostOffline)).toBe("Blocked");
    expect(threadTone(blocked, hostOffline)).toBe("waiting");
    expect(waitingCount([blocked], unreachable)).toBe(1);
  });
});

describe("threads on an unreachable host", () => {
  const blocked = thread({ reportedBlocker: "Commit these changes, or discard them?" });
  const offline = new Set([blocked.environmentId as string]);

  it("says the host is offline instead of Blocked and does not wait on the person", () => {
    expect(threadStatusWord(blocked, true)).toBe("Host offline");
    expect(threadTone(blocked, true)).toBe("idle");
    expect(waitingCount([blocked], offline)).toBe(0);
    expect(threadsSummary([blocked], 0, offline)).toBe("Nothing is waiting on you.");
  });

  it("lists it as idle rather than working from a stale runtime", () => {
    const groups = buildThreadPaneGroups(
      [
        blocked,
        thread({
          id: "worker-2",
          reportedBlocker: "Commit these changes, or discard them?",
          runtime: running,
        }),
      ],
      "activity",
      "",
      undefined,
      offline,
    );
    expect(groups.find((g) => g.group === "Idle")?.threads).toHaveLength(2);
    expect(groups.find((g) => g.group === "Waiting on you")?.threads).toHaveLength(0);
  });

  it("keeps a resolved thread resolved and is unchanged once the host is back", () => {
    expect(threadTone({ ...blocked, settledOverride: "settled" }, true)).toBe("resolved");
    expect(threadStatusWord({ ...blocked, settledOverride: "settled" }, true)).toBeNull();
    expect(threadStatusWord(blocked, false)).toBe("Blocked");
    expect(waitingCount([blocked], new Set())).toBe(1);
  });
});
