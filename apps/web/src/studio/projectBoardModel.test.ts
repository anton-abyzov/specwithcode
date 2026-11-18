import { describe, expect, it } from "vite-plus/test";

import type { ProjectBoardCard } from "@specweave-studio/contracts";

import {
  BOARD_CARD_REASONS,
  BOARD_GROUPS,
  BOARD_GROUPS_WIDE,
  BOARD_NO_THREAD,
  NO_BOARD_PROMOTIONS,
  boardAsk,
  boardBlockedChip,
  boardCardBlocked,
  boardCardGroup,
  boardCardMachines,
  boardCardOnMachine,
  boardCardPaused,
  boardCardTitle,
  boardColumnMore,
  boardEdgeLabel,
  boardGroupCounts,
  boardGroups,
  boardIsEmpty,
  boardMachineOptions,
  boardNoteText,
  boardOutOfReachNote,
  boardProgress,
  boardPullRequestChip,
  boardPullRequestStates,
  boardReasons,
  boardRestCanContinue,
  boardStateLabel,
  boardThreadEvidence,
  boardThreadOrder,
  boardWithPromotions,
  incrementNumber,
  nextBoardPromotions,
  pullRequestLabel,
  threadIsLive,
  threadShowsWork,
} from "./projectBoardModel";

const card = (incrementId: string, column: ProjectBoardCard["column"]): ProjectBoardCard => ({
  incrementId,
  title: null,
  status: "active",
  column,
  tasks: { total: 0, done: 0 },
  blocked: false,
  updatedAt: null,
  pullRequests: [],
  specPath: null,
});

describe("projectBoardModel", () => {
  it("groups cards by column and keeps the server's order", () => {
    const groups = boardGroups([
      card("0003-c", "active"),
      card("0002-b", "done"),
      card("0001-a", "active"),
    ]);
    expect(groups.active.map((entry) => entry.incrementId)).toEqual(["0003-c", "0001-a"]);
    expect(groups.done).toHaveLength(1);
    expect(groups.planned).toEqual([]);
    expect(groups.review).toEqual([]);
    expect(groups.blocked).toEqual([]);
  });

  it("names a card by number and title", () => {
    expect(incrementNumber("1334-direct-lan-path")).toBe("1334");
    expect(incrementNumber("0412B-follow-up")).toBe("0412B");
    expect(incrementNumber("notes")).toBe("notes");
    expect(boardCardTitle({ incrementId: "1334-direct-lan-path", title: "Direct LAN path" })).toBe(
      "Direct LAN path",
    );
    expect(boardCardTitle({ incrementId: "1334-direct-lan-path", title: null })).toBe(
      "direct lan path",
    );
  });

  it("labels pull requests and progress", () => {
    expect(pullRequestLabel("https://github.com/acme/app/pull/371")).toBe("#371");
    expect(pullRequestLabel("https://example.com/x")).toBe("PR");
    expect(boardProgress({ total: 0, done: 0 })).toBeNull();
    expect(boardProgress({ total: 1, done: 1 })).toEqual({ label: "1/1 task", percent: 100 });
    expect(boardProgress({ total: 3, done: 2 })).toEqual({ label: "2/3 tasks", percent: 67 });
  });

  it("offers more held cards first, then older Done cards from the server", () => {
    expect(boardColumnMore({ column: "active", held: 71, shown: 40, total: 71 })).toEqual({
      kind: "more",
      label: "Show 31 more",
    });
    expect(boardColumnMore({ column: "active", held: 120, shown: 40, total: 120 })).toEqual({
      kind: "more",
      label: "Show 40 more",
    });
    expect(boardColumnMore({ column: "active", held: 12, shown: 40, total: 12 })).toBeNull();
    expect(boardColumnMore({ column: "done", held: 30, shown: 40, total: 558 })).toEqual({
      kind: "older",
      label: "Show older",
    });
    expect(boardColumnMore({ column: "done", held: 300, shown: 300, total: 558 })).toBeNull();
    expect(boardColumnMore({ column: "done", held: 30, shown: 40, total: 30 })).toBeNull();
  });

  it("knows an empty board", () => {
    expect(boardIsEmpty({ counts: { planned: 0, active: 0, review: 0, done: 0 } })).toBe(true);
    expect(boardIsEmpty({ counts: { planned: 0, active: 0, review: 0, done: 2 } })).toBe(false);
  });

  it("orders a card's threads by who needs the person, then the newest", () => {
    const thread = (id: string, tone: string, updatedAt: string) => ({ id, tone, updatedAt });
    expect(
      boardThreadOrder([
        thread("done", "resolved", "2026-11-14T10:00:00Z"),
        thread("old", "working", "2026-11-14T08:00:00Z"),
        thread("ask", "waiting", "2026-11-13T08:00:00Z"),
        thread("new", "working", "2026-11-14T09:00:00Z"),
      ]).map((entry) => entry.id),
    ).toEqual(["ask", "new", "old", "done"]);
  });

  it("words the request for an open card by how far it is", () => {
    const at = (column: ProjectBoardCard["column"], done: number) =>
      boardAsk({ incrementId: "0007-login", column, tasks: { total: 4, done } });
    expect(at("planned", 0)?.label).toBe("Start");
    expect(at("active", 0)?.label).toBe("Start");
    expect(at("active", 2)).toEqual({
      label: "Continue",
      prompt: "Continue increment 0007-login: pick up its next open task.",
    });
    expect(at("review", 4)?.label).toBe("Review and close");
    expect(at("done", 4)).toBeNull();
  });

  it("still asks to Start a card that names no task", () => {
    expect(
      boardAsk({ incrementId: "0007-login", column: "planned", tasks: { total: 0, done: 0 } }),
    ).toEqual({
      label: "Start",
      prompt: "Start work on increment 0007-login: read its spec and begin with the first task.",
    });
  });
});

const blockedCard = (overrides: Partial<ProjectBoardCard> = {}): ProjectBoardCard => ({
  ...card("0040-search", "active"),
  tasks: { total: 6, done: 2 },
  ...overrides,
});

describe("threads that show work", () => {
  it("counts working, background, waiting and failed threads as work", () => {
    for (const tone of ["working", "background", "waiting", "failed"])
      expect(threadShowsWork(tone)).toBe(true);
  });

  it("never counts idle, resolved, unknown or anything else as work", () => {
    for (const tone of ["idle", "resolved", "unknown", "offline", "", "Working"])
      expect(threadShowsWork(tone)).toBe(false);
  });

  it("treats resolved and unknown threads as gone and the rest as live", () => {
    expect(threadIsLive("resolved")).toBe(false);
    expect(threadIsLive("unknown")).toBe(false);
    for (const tone of ["working", "background", "waiting", "failed", "idle"])
      expect(threadIsLive(tone)).toBe(true);
  });
});

describe("the blocked state of a card", () => {
  it("reads a pause from the field, else from an older server's status", () => {
    expect(boardCardPaused({ paused: true, status: "active" })).toBe(true);
    expect(boardCardPaused({ paused: false, status: "paused" })).toBe(false);
    expect(boardCardPaused({ status: "paused" })).toBe(true);
    expect(boardCardPaused({ status: "active" })).toBe(false);
    expect(boardCardPaused({})).toBe(false);
  });

  it("keeps paused cards and cards with blocked tasks, never a finished one", () => {
    expect(boardCardBlocked(blockedCard())).toBe(false);
    expect(boardCardBlocked(blockedCard({ paused: true }))).toBe(true);
    expect(boardCardBlocked(blockedCard({ blockedTasks: 1 }))).toBe(true);
    expect(boardCardBlocked(blockedCard({ blocked: true }))).toBe(true);
    expect(boardCardBlocked(blockedCard({ status: "paused" }))).toBe(true);
    expect(
      boardCardBlocked(
        blockedCard({ column: "done", paused: true, blocked: true, blockedTasks: 2 }),
      ),
    ).toBe(false);
  });

  it("words the chip by what is stuck, the pause first", () => {
    expect(boardBlockedChip(blockedCard({ blocked: true, paused: true, blockedTasks: 2 }))).toBe(
      "Paused + 2 tasks blocked",
    );
    expect(boardBlockedChip(blockedCard({ blocked: true, paused: true, blockedTasks: 1 }))).toBe(
      "Paused + 1 task blocked",
    );
    expect(boardBlockedChip(blockedCard({ blocked: true, paused: true, blockedTasks: 0 }))).toBe(
      "Paused",
    );
    expect(boardBlockedChip(blockedCard({ blocked: true, blockedTasks: 1 }))).toBe(
      "1 task blocked",
    );
    expect(boardBlockedChip(blockedCard({ blocked: true, blockedTasks: 3 }))).toBe(
      "3 tasks blocked",
    );
    expect(boardBlockedChip(blockedCard({ blocked: true }))).toBe("Blocked");
    expect(boardBlockedChip(blockedCard())).toBeNull();
    expect(boardBlockedChip(blockedCard({ column: "done", blocked: true, blockedTasks: 1 }))).toBe(
      null,
    );
  });

  it("says the rest can continue only while open tasks outnumber the blocked ones", () => {
    expect(boardRestCanContinue(blockedCard({ blocked: true, blockedTasks: 1 }))).toBe(true);
    expect(
      boardRestCanContinue(
        blockedCard({ blocked: true, blockedTasks: 2, tasks: { total: 6, done: 4 } }),
      ),
    ).toBe(false);
    expect(boardRestCanContinue(blockedCard())).toBe(false);
    expect(
      boardRestCanContinue(blockedCard({ blocked: true, paused: true, blockedTasks: 1 })),
    ).toBe(false);
    expect(
      boardRestCanContinue(blockedCard({ column: "done", blocked: true, blockedTasks: 1 })),
    ).toBe(false);
  });

  it("lists the pause reason first, then every blocker, and leaves the cap to the card", () => {
    const blocker = (taskId: string, note: string | null) => ({
      taskId,
      title: `Task ${taskId}`,
      note,
      by: "agent@desk",
      at: "2026-11-15T10:00:00Z",
    });
    const reasons = boardReasons(
      blockedCard({
        paused: true,
        pausedReason: "  waiting for the design  ",
        blockers: [blocker("T-02", "needs a key"), blocker("T-04", " "), blocker("T-05", null)],
      }),
    );
    expect(reasons).toEqual([
      { taskId: null, text: "waiting for the design" },
      { taskId: "T-02", text: "needs a key" },
      { taskId: "T-04", text: "blocked, no reason given" },
      { taskId: "T-05", text: "blocked, no reason given" },
    ]);
    expect(reasons.length).toBeGreaterThan(BOARD_CARD_REASONS);
    expect(boardReasons(blockedCard({ paused: true, pausedReason: null }))).toEqual([
      { taskId: null, text: "no reason given" },
    ]);
    expect(boardReasons(blockedCard())).toEqual([]);
    expect(
      boardReasons(blockedCard({ column: "done", paused: true, blockers: [blocker("T-02", "x")] })),
    ).toEqual([]);
  });

  it("gives no pause line for an older server that sends only the status", () => {
    expect(boardReasons(blockedCard({ status: "paused" }))).toEqual([]);
  });

  it("cleans a squeezed reason before it is shown", () => {
    expect(
      boardReasons(
        blockedCard({
          paused: true,
          pausedReason: "  waiting,then   retry ",
          blockers: [{ taskId: "T-02", title: "", note: "copies kept;3lost", by: null, at: null }],
        }),
      ).map((reason) => reason.text),
    ).toEqual(["waiting, then retry", "copies kept; 3lost"]);
  });
});

describe("board groups", () => {
  const cards = [
    blockedCard({ incrementId: "0001-a", column: "planned", paused: true }),
    blockedCard({ incrementId: "0002-b", blocked: true, paused: true, blockedTasks: 2 }),
    blockedCard({ incrementId: "0003-c", blocked: true, blockedTasks: 1 }),
    blockedCard({ incrementId: "0004-d" }),
    blockedCard({ incrementId: "0005-e", column: "review", blocked: true, blockedTasks: 1 }),
    blockedCard({ incrementId: "0006-f", column: "done", blocked: true, blockedTasks: 1 }),
  ];

  it("lists Blocked first when stacked, and before the columns side by side", () => {
    expect(BOARD_GROUPS).toEqual(["blocked", "active", "review", "planned", "done"]);
    expect(BOARD_GROUPS_WIDE).toEqual(["blocked", "planned", "active", "review", "done"]);
  });

  it("lists a stuck card under Blocked only, and never a finished one", () => {
    const groups = boardGroups(cards);
    expect(groups.blocked.map((entry) => entry.incrementId)).toEqual([
      "0001-a",
      "0002-b",
      "0003-c",
      "0005-e",
    ]);
    expect(groups.active.map((entry) => entry.incrementId)).toEqual(["0004-d"]);
    expect(groups.planned).toEqual([]);
    expect(groups.review).toEqual([]);
    expect(groups.done.map((entry) => entry.incrementId)).toEqual(["0006-f"]);
    expect(boardCardGroup(cards[0]!)).toBe("blocked");
    expect(boardCardGroup(cards[5]!)).toBe("done");
  });

  it("takes each blocked card off its column's count, so the five add up", () => {
    const groups = boardGroups(cards);
    // The server counts 40 Done and sent one of them.
    const counts = boardGroupCounts({ planned: 1, active: 3, review: 1, done: 40 }, groups.blocked);
    expect(counts).toEqual({ blocked: 4, planned: 0, active: 1, review: 0, done: 40 });
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(45);
  });

  it("labels a blocked card with the state it left, and no other card", () => {
    expect(boardStateLabel(cards[0]!)).toBe("Planned");
    expect(boardStateLabel(cards[1]!)).toBe("Active");
    expect(boardStateLabel(cards[4]!)).toBe("In review");
    expect(boardStateLabel(cards[3]!)).toBeUndefined();
    expect(boardStateLabel(cards[5]!)).toBeUndefined();
  });
});

describe("the machines of a card", () => {
  const on = (id: string, tone: string, label = id, moved = false) => ({
    tone,
    color: `color-${id}`,
    machine: { executionMachineId: id, label, moved },
  });

  it("names each machine once, in thread order, and skips resolved threads", () => {
    expect(
      boardCardMachines([
        on("desk", "working"),
        on("mini", "idle", "Desk → Mini", true),
        on("desk", "waiting"),
        on("spare", "unknown"),
        on("lab", "resolved"),
      ]),
    ).toEqual([
      { id: "desk", name: "desk", color: "color-desk" },
      { id: "mini", name: "Mini", color: "color-mini" },
      { id: "spare", name: "spare", color: "color-spare" },
    ]);
    expect(boardCardMachines([on("lab", "resolved")])).toEqual([]);
  });

  it("keeps a card for a machine by the rule its edge is drawn by", () => {
    const open = card("0001-a", "active");
    const threads = [on("desk", "working"), on("lab", "resolved")];
    expect(boardCardOnMachine(open, threads, null)).toBe(true);
    expect(boardCardOnMachine(open, threads, "desk")).toBe(true);
    expect(boardCardOnMachine(open, threads, "lab")).toBe(false);
    expect(boardCardOnMachine(open, threads, BOARD_NO_THREAD)).toBe(false);
    expect(boardCardOnMachine(open, [on("lab", "resolved")], BOARD_NO_THREAD)).toBe(true);
    // Finished work is never "open work nobody holds", and runs on no machine.
    const done = card("0002-b", "done");
    expect(boardCardOnMachine(done, [], BOARD_NO_THREAD)).toBe(false);
    expect(boardCardOnMachine(done, [on("desk", "idle")], "desk")).toBe(false);
    expect(boardCardOnMachine(done, [on("desk", "idle")], null)).toBe(true);
  });

  it("says the edge in words, every machine past the third counted", () => {
    const names = (...list: string[]) => list.map((name) => ({ name }));
    expect(boardEdgeLabel(names("desk"))).toBe("Runs on desk");
    expect(boardEdgeLabel(names("desk", "mini"))).toBe("Runs on desk and mini");
    expect(boardEdgeLabel(names("desk", "mini", "lab"))).toBe("Runs on desk, mini and lab");
    expect(boardEdgeLabel(names("desk", "mini", "lab", "spare"))).toBe(
      "Runs on desk, mini, lab and 1 more machine",
    );
    expect(boardEdgeLabel(names("a", "b", "c", "d", "e"))).toBe(
      "Runs on a, b, c and 2 more machines",
    );
  });

  it("names the threads out of reach for a request, and says nothing without one", () => {
    const entry = (tone: string, title: string, label: string) => ({
      tone,
      thread: { title },
      machine: { label },
    });
    expect(boardOutOfReachNote([])).toBe("");
    expect(
      boardOutOfReachNote([entry("resolved", "Old", "desk"), entry("idle", "Now", "desk")]),
    ).toBe("");
    expect(
      boardOutOfReachNote([
        entry("resolved", "Old", "desk"),
        entry("unknown", "Sync", "desk → mini"),
      ]),
    ).toBe(
      ' Check first: the thread "Sync" on mini cannot be reached now and may still hold this work. Do not start another worker beside it.',
    );
    expect(
      boardOutOfReachNote([
        entry("unknown", "", "lab"),
        entry("unknown", "B", "lab"),
        entry("unknown", "C", "lab"),
      ]),
    ).toContain('the thread "Untitled thread" on lab and 2 more threads cannot be reached now');
  });

  it("lists machines by their cards, then No thread once the threads have answered", () => {
    const cards = [
      card("0001-a", "active"),
      card("0002-b", "active"),
      card("0003-c", "planned"),
      card("0004-d", "done"),
    ];
    // A finished card counts for no machine, even with a thread nobody settled.
    const threads = new Map([
      ["0001-a", [on("mini", "working"), on("desk", "idle")]],
      ["0002-b", [on("desk", "working")]],
      ["0004-d", [on("lab", "resolved"), on("spare", "idle")]],
    ]);
    expect(boardMachineOptions(cards, threads, true)).toEqual([
      { id: "desk", name: "desk", color: "color-desk", cards: 2 },
      { id: "mini", name: "mini", color: "color-mini", cards: 1 },
      { id: BOARD_NO_THREAD, name: "No thread", color: null, cards: 1 },
    ]);
    expect(boardMachineOptions(cards, threads, false).map((option) => option.id)).toEqual([
      "desk",
      "mini",
    ]);
    // No machine at all: nothing to tell apart, so no "No thread" either.
    expect(boardMachineOptions(cards, new Map(), true)).toEqual([]);
  });
});

describe("a reason as the board shows it", () => {
  it("adds the space left out after a comma or a semicolon", () => {
    expect(boardNoteText("check passed;12/40 copies kept,7missing")).toBe(
      "check passed; 12/40 copies kept, 7missing",
    );
    expect(boardNoteText("first,second;third")).toBe("first, second; third");
  });

  it("never splits a word, an id, a version or a number", () => {
    for (const text of [
      "T-64 waits on HTTPX",
      "version 1.0.343 of sha256abc",
      "offline37profileattestation",
      "1,234 rows and 12,5 more",
      "already fine, as written; nothing to do",
      "ends with a comma,",
    ])
      expect(boardNoteText(text)).toBe(text);
  });

  it("leaves numbers, bracketed lists, paths and file names as written", () => {
    for (const text of [
      "grew 1,5x since",
      "kept a,b.txt and c,d.json.",
      "call f(a,b) then g[1,a]",
      "open data:text/plain,hello",
      "see src/a,b and ./x,y",
      "mailto:a,b@example.test",
      "C:\\work\\a,b",
    ])
      expect(boardNoteText(text)).toBe(text);
  });

  it("reads a slash between numbers as a ratio, not a path", () => {
    expect(boardNoteText("valid;113/148 copies recovered,35unresolved. Next")).toBe(
      "valid; 113/148 copies recovered, 35unresolved. Next",
    );
  });

  it("knows the letters and digits of any script", () => {
    expect(boardNoteText("готово,дальше;проверка")).toBe("готово, дальше; проверка");
    expect(boardNoteText("完了,次へ")).toBe("完了, 次へ");
  });

  it("leaves text in backticks exactly as written, spaces included", () => {
    expect(boardNoteText("run `a,b   c;d`  then,stop")).toBe("run `a,b   c;d` then, stop");
  });

  it("leaves links, backticks and character references as written", () => {
    expect(boardNoteText("see https://example.test/a,b;c for more")).toBe(
      "see https://example.test/a,b;c for more",
    );
    expect(boardNoteText("run `pick a,b;c` first,then stop")).toBe(
      "run `pick a,b;c` first, then stop",
    );
    expect(boardNoteText("a &amp;b and &#38;c")).toBe("a &amp;b and &#38;c");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(boardNoteText("  two   spaces\n\nand a\tbreak ")).toBe("two spaces and a break");
    expect(boardNoteText("")).toBe("");
  });
});

describe("the pull request chip", () => {
  const url = (number: number) => `https://github.com/acme/app/pull/${number}`;

  it("gives a state only to a pull request a thread has read from the host", () => {
    const link = (
      number: number,
      linkedAt: string,
      snapshot?: { state: string; isDraft?: boolean } | null,
      source?: string,
    ) => ({ url: url(number), linkedAt, snapshot, source });
    const states = boardPullRequestStates([
      {
        pullRequests: [
          link(1, "2026-11-01T00:00:00.000Z", { state: "merged" }),
          link(2, "2026-11-01T00:00:00.000Z", { state: "open", isDraft: true }),
          // Linked, never read: no word, and never an assumed "Open".
          link(3, "2026-11-01T00:00:00.000Z"),
          link(4, "2026-11-01T00:00:00.000Z", null),
          link(5, "2026-11-01T00:00:00.000Z", { state: "open" }, "stack-dismissed"),
          link(6, "2026-11-01T00:00:00.000Z", { state: "queued" }),
        ],
      },
      // The newest link of a pull request wins, whichever thread holds it.
      { pullRequests: [link(1, "2026-10-01T00:00:00.000Z", { state: "open" })] },
      { pullRequests: [link(2, "2026-11-02T00:00:00.000Z", { state: "closed" })] },
      { deletedAt: "2026-11-03T00:00:00.000Z", pullRequests: [link(3, "x", { state: "open" })] },
      {},
    ]);
    expect([...states]).toEqual([
      [url(1), "Merged"],
      [url(2), "Closed"],
      [url(6), "queued"],
    ]);
  });

  it("is absent with no pull request and the number of a single one", () => {
    expect(boardPullRequestChip([])).toBeNull();
    expect(boardPullRequestChip([url(193)])).toEqual({ kind: "one", url: url(193), label: "#193" });
  });

  it("folds several into one chip with a menu, newest first as the server sent them", () => {
    expect(boardPullRequestChip([url(524), url(76), url(75)])).toEqual({
      kind: "many",
      label: "3 PRs",
      items: [
        { url: url(524), label: "#524" },
        { url: url(76), label: "#76" },
        { url: url(75), label: "#75" },
      ],
    });
  });
});

describe("cards moved into Active by their threads", () => {
  it("takes only planned cards with a thread that shows work", () => {
    const cards = [
      card("0001-a", "planned"),
      card("0002-b", "planned"),
      card("0003-c", "planned"),
      card("0004-d", "review"),
      card("0005-e", "planned"),
    ];
    const threads = new Map([
      ["0001-a", [{ tone: "idle" }, { tone: "working" }]],
      ["0002-b", [{ tone: "idle" }, { tone: "resolved" }, { tone: "unknown" }]],
      ["0003-c", [{ tone: "waiting" }]],
      ["0004-d", [{ tone: "working" }]],
    ]);
    expect(boardThreadEvidence(cards, threads)).toEqual(["0001-a", "0003-c"]);
  });

  it("only grows within one refresh and settles on the next", () => {
    const first = nextBoardPromotions(NO_BOARD_PROMOTIONS, 1, ["0001-a"]);
    expect(first.revision).toBe(1);
    expect([...first.ids]).toEqual(["0001-a"]);

    const idle = nextBoardPromotions(first, 1, []);
    expect(idle).toBe(first);

    const second = nextBoardPromotions(idle, 1, ["0002-b"]);
    expect([...second.ids].toSorted()).toEqual(["0001-a", "0002-b"]);

    const refreshed = nextBoardPromotions(second, 2, ["0002-b"]);
    expect(refreshed.revision).toBe(2);
    expect([...refreshed.ids]).toEqual(["0002-b"]);

    const nothing = nextBoardPromotions(refreshed, 3, []);
    expect(nothing.revision).toBe(3);
    expect(nothing.ids.size).toBe(0);
  });

  it("keeps the same set on a refresh with the same evidence", () => {
    const first = nextBoardPromotions(NO_BOARD_PROMOTIONS, 1, ["0001-a", "0002-b"]);
    const again = nextBoardPromotions(first, 2, ["0002-b", "0001-a"]);
    expect(again.revision).toBe(2);
    expect(again.ids).toBe(first.ids);
  });

  it("moves promoted planned cards to Active and keeps the headings counting them", () => {
    const result = {
      cards: [
        card("0001-a", "planned"),
        card("0002-b", "planned"),
        card("0003-c", "active"),
        card("0004-d", "review"),
        card("0005-e", "done"),
      ],
      counts: { planned: 2, active: 1, review: 1, done: 9 },
    };
    const moved = boardWithPromotions(result, new Set(["0001-a", "0004-d", "0005-e"]));
    expect(moved.cards.map((entry) => [entry.incrementId, entry.column])).toEqual([
      ["0001-a", "active"],
      ["0002-b", "planned"],
      ["0003-c", "active"],
      ["0004-d", "review"],
      ["0005-e", "done"],
    ]);
    expect(moved.counts).toEqual({ planned: 1, active: 2, review: 1, done: 9 });
    expect(result.cards[0]!.column).toBe("planned");
  });

  it("leaves a board with nothing to move as it was", () => {
    const result = {
      cards: [card("0001-a", "planned"), card("0004-d", "review")],
      counts: { planned: 1, active: 0, review: 1, done: 0 },
    };
    expect(boardWithPromotions(result, new Set())).toBe(result);
    expect(boardWithPromotions(result, new Set(["0004-d", "9999-gone"]))).toBe(result);
  });
});

describe("boardAsk for blocked and paused work", () => {
  const ask = (overrides: Parameters<typeof boardAsk>[0]) => boardAsk(overrides);
  const base = { incrementId: "0007-login", tasks: { total: 4, done: 0 } };

  it("resumes a paused card with its reason, in any open column", () => {
    expect(
      ask({ ...base, column: "active", paused: true, pausedReason: " waiting on the key " }),
    ).toEqual({
      label: "Resume",
      prompt:
        'Resume increment 0007-login: it is paused ("waiting on the key"). Check whether that still holds, then pick up its next open task.',
    });
    expect(ask({ ...base, column: "review", status: "paused" })?.label).toBe("Resume");
    expect(ask({ ...base, column: "planned", paused: true })?.prompt).toBe(
      "Resume increment 0007-login: it is paused. Check whether that still holds, then pick up its next open task.",
    );
  });

  it("continues work that started with a claim or a block, starts it otherwise", () => {
    expect(ask({ ...base, column: "active", tasks: { total: 4, done: 0, active: 1 } })?.label).toBe(
      "Continue",
    );
    expect(ask({ ...base, column: "active", blockedTasks: 1 })?.label).toBe("Continue");
    expect(ask({ ...base, column: "planned", blockedTasks: 0 })?.label).toBe("Start");
  });

  it("asks nothing of a done card, paused or not", () => {
    expect(ask({ ...base, column: "done", paused: true })).toBeNull();
  });
});
