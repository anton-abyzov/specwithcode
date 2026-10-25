import type {
  DesignApplyInput,
  DesignCopyInput,
  DesignMoveInput,
  DesignSummary,
} from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  connectDesign,
  duplicateDesign,
  duplicateTitle,
  renameDesign,
  type MoveOutcome,
  type Outcome,
  type ThreadMoveRequest,
} from "./designMenuActions";

const summary = (owner: unknown, title = "Pricing page", revision = 7) =>
  ({
    ref: { owner, designId: "d_pricing", path: ".specweave/design/d_pricing/design.json" },
    kind: "design",
    title,
    revision,
    updatedAt: "2026-10-20T15:00:00.000Z",
    pageCount: 1,
    designSystem: null,
    ownerLabel: "Atlas web",
  }) as DesignSummary;

const project = { kind: "project", environmentId: "host", projectId: "atlas-web" };
const playground = { kind: "playground", environmentId: "host" };
const ok = <A>(value: A): Outcome<A> => ({ ok: true, value });

describe("renameDesign", () => {
  it("sets the title at the revision the list showed", async () => {
    const apply = vi.fn(async (_input: DesignApplyInput) => ok({}));
    expect(await renameDesign(apply, summary(project), "  Pricing v2 ")).toBeNull();
    expect(apply).toHaveBeenCalledWith({
      owner: { kind: "project", projectId: "atlas-web" },
      designId: "d_pricing",
      expectedRevision: 7,
      operations: [{ op: "set_title", title: "Pricing v2" }],
    });
  });

  it("returns the server's conflict message", async () => {
    const apply = vi.fn(async (): Promise<Outcome<unknown>> => ({
      ok: false,
      message: "The design changed since revision 7. Reload it and try again.",
    }));
    expect(await renameDesign(apply, summary(project), "Pricing v2")).toBe(
      "The design changed since revision 7. Reload it and try again.",
    );
  });

  it("skips the write for an unchanged title and refuses an empty one", async () => {
    const apply = vi.fn(async () => ok({}));
    expect(await renameDesign(apply, summary(project), "Pricing page")).toBeNull();
    expect(await renameDesign(apply, summary(project), "   ")).toBe("Enter a title.");
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("duplicateDesign", () => {
  it("copies into the same owner, then titles the copy at its first revision", async () => {
    const copy = vi.fn(async (input: DesignCopyInput) =>
      ok({ ref: { owner: input.to, designId: "d_copy" } as never, document: { revision: 0 } }),
    );
    const apply = vi.fn(async (_input: DesignApplyInput) => ok({}));
    const result = await duplicateDesign({ copy, apply }, summary(playground, "Moodboard"));
    expect(copy).toHaveBeenCalledWith({
      owner: { kind: "playground" },
      designId: "d_pricing",
      to: { kind: "playground" },
    });
    expect(apply).toHaveBeenCalledWith({
      owner: { kind: "playground" },
      designId: "d_copy",
      expectedRevision: 0,
      operations: [{ op: "set_title", title: "Moodboard copy" }],
    });
    expect(result).toMatchObject({ ok: true, title: "Moodboard copy", renameProblem: null });
  });

  it("keeps the copy and reports the problem when the rename fails", async () => {
    const copy = vi.fn(async () =>
      ok({ ref: { designId: "d_copy" } as never, document: { revision: 0 } }),
    );
    const apply = vi.fn(async (): Promise<Outcome<unknown>> => ({
      ok: false,
      message: "Disk full.",
    }));
    expect(await duplicateDesign({ copy, apply }, summary(project))).toMatchObject({
      ok: true,
      title: "Pricing page",
      renameProblem: "Disk full.",
    });
  });

  it("stops when the copy fails", async () => {
    const apply = vi.fn(async () => ok({}));
    const result = await duplicateDesign(
      { copy: async () => ({ ok: false, message: "No room." }), apply },
      summary(project),
    );
    expect(result).toEqual({ ok: false, message: "No room." });
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps the copy title within 180 characters", () => {
    expect(duplicateTitle("x".repeat(180))).toHaveLength(180);
    expect(duplicateTitle("")).toBe("Untitled copy");
  });
});

describe("connectDesign", () => {
  const moved = (input: DesignMoveInput): MoveOutcome => ({
    ok: true,
    value: {
      ref: {
        owner: { kind: "project", environmentId: "host", projectId: "atlas-web" },
        designId: input.designId,
        path: `.specweave/design/${input.designId}/design.json`,
      } as never,
    },
  });
  const request = {
    designId: "d_pricing" as never,
    expectedRevision: 7,
    projectId: "atlas-web" as never,
    threadId: "t_scratch" as never,
  };

  it("moves the design, then moves its thread into the same project", async () => {
    const order: string[] = [];
    const move = vi.fn(async (input: DesignMoveInput) => {
      order.push("move");
      return moved(input);
    });
    const moveThread = vi.fn(async (_input: ThreadMoveRequest) => {
      order.push("thread");
      return ok({});
    });
    const result = await connectDesign(
      { move, moveThread, newThreadId: () => "t_new" as never },
      request,
    );
    expect(order).toEqual(["move", "thread"]);
    expect(move).toHaveBeenCalledWith({
      owner: { kind: "playground" },
      designId: "d_pricing",
      to: { kind: "project", projectId: "atlas-web" },
      expectedRevision: 7,
    });
    expect(moveThread).toHaveBeenCalledWith({
      commandId: "move:t_new",
      threadId: "t_scratch",
      targetProjectId: "atlas-web",
      targetThreadId: "t_new",
    });
    expect(result).toMatchObject({
      ok: true,
      ref: { designId: "d_pricing" },
      threadProblem: null,
    });
  });

  it("keeps the design moved and returns the thread move to retry when it fails", async () => {
    const moveThread = vi
      .fn<(input: ThreadMoveRequest) => Promise<Outcome<unknown>>>()
      .mockResolvedValueOnce({ ok: false, message: "The machine went offline." })
      .mockResolvedValueOnce(ok({}));
    const result = await connectDesign(
      { move: async (input) => moved(input), moveThread, newThreadId: () => "t_new" as never },
      request,
    );
    expect(result).toMatchObject({ ok: true, threadProblem: "The machine went offline." });
    if (!result.ok || result.thread === null) throw new Error("expected a thread to retry");
    // A retry sends the same ids, so the server resumes the same move.
    expect(await moveThread(result.thread)).toEqual({ ok: true, value: {} });
    expect(moveThread.mock.calls[1]![0]).toEqual(moveThread.mock.calls[0]![0]);
  });

  it("moves no thread when the person left it, or when the move fails", async () => {
    const moveThread = vi.fn(async () => ok({}));
    const alone = await connectDesign(
      { move: async (input) => moved(input), moveThread, newThreadId: () => "t_new" as never },
      { ...request, threadId: null },
    );
    expect(alone).toMatchObject({ ok: true, thread: null, threadProblem: null });
    const refused = await connectDesign(
      {
        move: async () => ({ ok: false, message: "Changed.", currentRevision: 9 }),
        moveThread,
        newThreadId: () => "t_new" as never,
      },
      request,
    );
    expect(refused).toEqual({ ok: false, message: "Changed.", currentRevision: 9 });
    expect(moveThread).not.toHaveBeenCalled();
  });
});
