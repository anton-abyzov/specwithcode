import { describe, expect, it } from "vite-plus/test";

import type { ProjectBoardCard } from "@specweave-studio/contracts";

import {
  boardAsk,
  boardCardTarget,
  boardCardTitle,
  boardColumnMore,
  boardColumns,
  boardIsEmpty,
  boardProgress,
  boardThreadOrder,
  incrementNumber,
  pullRequestLabel,
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
    const columns = boardColumns([
      card("0003-c", "active"),
      card("0002-b", "done"),
      card("0001-a", "active"),
    ]);
    expect(columns.active.map((entry) => entry.incrementId)).toEqual(["0003-c", "0001-a"]);
    expect(columns.done).toHaveLength(1);
    expect(columns.planned).toEqual([]);
    expect(columns.review).toEqual([]);
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

  it("opens the thread of a card with exactly one, the spec otherwise", () => {
    expect(boardCardTarget({ threads: 1, specPath: "/a/spec.md" })).toBe("thread");
    expect(boardCardTarget({ threads: 1, specPath: null })).toBe("thread");
    expect(boardCardTarget({ threads: 0, specPath: "/a/spec.md" })).toBe("spec");
    expect(boardCardTarget({ threads: 3, specPath: "/a/spec.md" })).toBe("spec");
    expect(boardCardTarget({ threads: 0, specPath: null })).toBe("none");
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
});
