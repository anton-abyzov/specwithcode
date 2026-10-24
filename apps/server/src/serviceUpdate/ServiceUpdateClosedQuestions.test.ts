import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import * as ClosedQuestions from "./ServiceUpdateClosedQuestions.ts";

const entry = (
  requestId: string,
  fields: Partial<ClosedQuestions.ClosedQuestion> = {},
): ClosedQuestions.ClosedQuestion => ({
  requestId,
  threadId: "t1",
  threadTitle: "Fix login",
  runId: "r1",
  kind: "user_input",
  text: "Which database should I use?",
  askedAt: "2026-10-21T09:00:00.000Z",
  closedAt: "2026-10-21T10:00:00.000Z",
  reopenedAt: null,
  ...fields,
});

const now = DateTime.makeUnsafe("2026-10-21T10:00:00.000Z");
const base = {
  threadId: ThreadId.make("t1"),
  runId: null,
  nodeId: NodeId.make("n1"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "waiting",
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
} as const;

describe("what a closed request asked", () => {
  it("quotes a question's own words and keeps its cards", () => {
    const item = {
      ...base,
      id: TurnItemId.make("item:q"),
      type: "user_input_request",
      requestId: RuntimeRequestId.make("q"),
      questions: [
        { id: "q1", header: "DB", question: "Which   database\nshould I use?", options: [] },
        { id: "q2", header: "Name", question: "And its name?", options: [] },
      ],
    } as unknown as OrchestrationV2TurnItem;
    const described = ClosedQuestions.describeClosedRequest({ kind: "user_input" }, item);
    expect(described.text).toBe("Which database should I use?\nAnd its name?");
    expect(described.questions).toHaveLength(2);
  });

  it("quotes an approval's prompt, and describes a request whose card is gone", () => {
    const item = {
      ...base,
      id: TurnItemId.make("item:a"),
      type: "approval_request",
      requestId: RuntimeRequestId.make("a"),
      requestKind: "command",
      prompt: "Run npm publish",
    } as unknown as OrchestrationV2TurnItem;
    expect(ClosedQuestions.describeClosedRequest({ kind: "command" }, item).text).toBe(
      "Run npm publish",
    );
    expect(ClosedQuestions.describeClosedRequest({ kind: "file-change" }, undefined).text).toBe(
      "Approve a file-change step.",
    );
    expect(ClosedQuestions.describeClosedRequest({ kind: "auth_refresh" }, undefined).text).toBe(
      "Sign in again so the agent can go on.",
    );
  });
});

describe("whether the update closed a request", () => {
  it("counts a cancelled or dismissed request, never an answered or pending one", () => {
    expect(ClosedQuestions.wasClosed({ status: "cancelled" })).toBe(true);
    expect(ClosedQuestions.wasClosed({ status: "expired" })).toBe(true);
    // The drain dismisses a question asked as a message: resolved, cancel, no answer.
    expect(ClosedQuestions.wasClosed({ status: "resolved", decision: "cancel" })).toBe(true);
    expect(ClosedQuestions.wasClosed({ status: "resolved", decision: "accept" })).toBe(false);
    expect(
      ClosedQuestions.wasClosed({ status: "resolved", decision: "cancel", answers: { q1: "x" } }),
    ).toBe(false);
    expect(ClosedQuestions.wasClosed({ status: "pending" })).toBe(false);
  });
});

describe("the reopen note and question", () => {
  it("quotes the closed question and says how it comes back", () => {
    expect(ClosedQuestions.closedQuestionNote(entry("q"), "card")).toBe(
      "The SpecWithCode update closed this question while it waited for your answer:\n\n> Which database should I use?\n\nIt is asked again below.",
    );
    expect(ClosedQuestions.closedQuestionNote(entry("q"), "agent")).toContain(
      "The agent continues and asks it again.",
    );
    expect(
      ClosedQuestions.closedQuestionNote(
        entry("a", { kind: "command", text: "Run npm publish" }),
        "card",
      ),
    ).toContain("closed this approval request while it waited for you:\n\n> Run npm publish");
  });

  it("asks a question again as it was, and an approval as a go-ahead question", () => {
    const cards = [{ id: "q1", header: "DB", question: "Which database?", options: [] }];
    expect(ClosedQuestions.reopenedQuestions(entry("q", { questions: cards }))).toEqual(cards);
    const [approval] = ClosedQuestions.reopenedQuestions(
      entry("a", { kind: "command", text: "Run npm publish" }),
    );
    expect(approval?.question).toBe(
      "The update closed this approval request: Run npm publish Should the agent go ahead?",
    );
    expect(approval?.options.map((option) => option.label)).toEqual(["Go ahead", "Don't"]);
    expect(ClosedQuestions.reopenedQuestions(entry("s", { kind: "auth_refresh" }))[0]?.header).toBe(
      "Sign in",
    );
  });

  it("tells a continuing agent to ask its question again", () => {
    expect(ClosedQuestions.closedQuestionsPrompt([])).toBeNull();
    const prompt = ClosedQuestions.closedQuestionsPrompt([
      entry("q"),
      entry("a", { kind: "command", text: "Run npm publish" }),
    ]);
    expect(prompt).toContain(
      "the SpecWithCode update closed your question before the person answered:\n\n> Which database should I use?\n\nAsk it again",
    );
    expect(prompt).toContain("> Run npm publish\n\nIf you still need that step, run it again");
    // A question closed twice (asked again, then closed by a later drain) is said once.
    const twice = ClosedQuestions.closedQuestionsPrompt([entry("q"), entry("update-reopen:q")]);
    expect(twice).toContain("closed your question before");
    expect(twice?.split("> Which database should I use?").length).toBe(2);
  });
});

it("keeps every unreopened entry and reopened ones for a week", () => {
  const nowMs = Date.parse("2026-10-21T10:00:00.000Z");
  const kept = ClosedQuestions.pruneClosedQuestions(
    [
      entry("open"),
      entry("recent", { reopenedAt: "2026-10-20T10:00:00.000Z" }),
      entry("old", { reopenedAt: "2026-10-01T10:00:00.000Z" }),
    ],
    nowMs,
  );
  expect(kept.map((kept) => kept.requestId)).toEqual(["open", "recent"]);
  expect(ClosedQuestions.parseClosedQuestions("not json")).toEqual([]);
});

const withStore = <A, E>(
  body: (input: {
    readonly recordPath: string;
    readonly store: ClosedQuestions.ServiceUpdateClosedQuestionsShape;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "closed-questions-" });
    const recordPath = path.join(dir, "updates", "closed-questions.json");
    const store = yield* ClosedQuestions.makeWithPath(recordPath);
    return yield* body({ recordPath, store });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("records each request once, durably, until it is reopened", () =>
  withStore(({ recordPath, store }) =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* store.record([entry("q1"), entry("a1", { kind: "command", runId: "r2" })]),
      );
      // A second record in the same drain repeats nothing.
      yield* store.record([entry("q1", { text: "changed" }), entry("q2")]);
      assert.deepEqual(
        (yield* store.pending).map((pending) => [pending.requestId, pending.text]),
        [
          ["q1", "Which database should I use?"],
          ["a1", "Which database should I use?"],
          ["q2", "Which database should I use?"],
        ],
      );
      // Each names the process that closed it.
      for (const pending of yield* store.pending) assert.equal(pending.closedIn, store.bootId);
      // A new process (the restarted service) reads the same record.
      const restarted = yield* ClosedQuestions.makeWithPath(recordPath);
      assert.notEqual(restarted.bootId, store.bootId);
      assert.lengthOf(yield* restarted.pending, 3);
      yield* restarted.markReopened([
        { requestId: "q1", by: "card" },
        { requestId: "a1", by: null },
      ]);
      assert.deepEqual(
        (yield* store.pending).map((pending) => pending.requestId),
        ["q2"],
      );
      // A continuation still finds what its run was asked after the reopen,
      // and how it was asked again.
      assert.deepEqual(
        (yield* store.forRun("t1", "r1")).map((found) => [found.requestId, found.reopenedBy]),
        [
          ["q1", "card"],
          ["q2", undefined],
        ],
      );
      // POSIX permission bits; Windows has no owner-only file mode.
      if (process.platform !== "win32") {
        const fs = yield* FileSystem.FileSystem;
        const info = yield* fs.stat(recordPath);
        assert.equal(Number(info.mode) & 0o777, 0o600);
      }
    }),
  ),
);

it.effect("answers false when the record cannot be written, so nothing is closed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "closed-questions-" });
    // "updates" is a file: the record's folder cannot be made (as on a full or read-only disk).
    yield* fs.writeFileString(path.join(dir, "updates"), "");
    const store = yield* ClosedQuestions.makeWithPath(
      path.join(dir, "updates", "closed-questions.json"),
    );
    assert.isFalse(yield* store.record([entry("q1")]));
    assert.lengthOf(yield* store.pending, 0);
    // Nothing to record needs no write.
    assert.isTrue(yield* store.record([]));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("says a drain is under way while one runs", () =>
  withStore(({ store }) =>
    Effect.gen(function* () {
      assert.isFalse(yield* store.isDraining);
      const during = yield* store.draining(store.isDraining);
      assert.isTrue(during);
      assert.isFalse(yield* store.isDraining);
      // A failed drain ends too.
      yield* store.draining(Effect.fail("boom")).pipe(Effect.ignore);
      assert.isFalse(yield* store.isDraining);
    }),
  ),
);

it("records again a request reopened while still open, and takes the latest close's timing", () => {
  const reopened = entry("q1", { reopenedAt: "2026-10-21T10:01:00.000Z", reopenedBy: "card" });
  // Still open when a later drain closes it: that close counts, and is asked again.
  const [again] = ClosedQuestions.mergeRecorded([reopened], [entry("q1")], "boot-2");
  assert.isNull(again!.reopenedAt);
  assert.equal(again!.closedIn, "boot-2");
  // A sweep's entry a forced drain records again no longer waits for a restart.
  const swept = entry("a1", { kind: "command", reopenAfterRestart: true, closedIn: "boot-1" });
  const [forced] = ClosedQuestions.mergeRecorded(
    [swept],
    [entry("a1", { kind: "command" })],
    "boot-2",
  );
  assert.isUndefined(forced!.reopenAfterRestart);
  assert.equal(forced!.closedIn, "boot-2");
  // The same close recorded twice changes nothing.
  const same = [entry("q2", { closedIn: "boot-1" })];
  assert.strictEqual(ClosedQuestions.mergeRecorded(same, [entry("q2")], "boot-1"), same);
});

it.effect("never overwrites a record it cannot read, and keeps entries it cannot decode", () =>
  withStore(({ recordPath, store }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(recordPath), { recursive: true });
      // A newer release wrote one entry this release does not know.
      const newer = { ...entry("n1"), reopenedBy: "phone" };
      yield* fs.writeFileString(
        recordPath,
        JSON.stringify({ version: 1, entries: [entry("q1"), newer] }),
      );
      assert.deepEqual(
        (yield* store.pending).map((pending) => pending.requestId),
        ["q1"],
      );
      assert.isTrue(yield* store.record([entry("q2")]));
      assert.isTrue(yield* store.markReopened([{ requestId: "q1", by: "card" }]));
      const written = JSON.parse(yield* fs.readFileString(recordPath)) as {
        readonly entries: ReadonlyArray<{ readonly requestId: string }>;
      };
      assert.deepEqual(
        written.entries.map((kept) => kept.requestId),
        ["q1", "q2", "n1"],
      );
      // Not a record at all: set aside, not overwritten.
      yield* fs.writeFileString(recordPath, "{not json");
      assert.isTrue(yield* store.record([entry("q3")]));
      const aside = (yield* fs.readDirectory(path.dirname(recordPath))).filter((name) =>
        name.startsWith("closed-questions.json.unreadable-"),
      );
      assert.lengthOf(aside, 1);
      assert.equal(
        yield* fs.readFileString(path.join(path.dirname(recordPath), aside[0]!)),
        "{not json",
      );
      // A file that cannot be read (a read error): nothing is written, and nothing may close.
      yield* fs.remove(recordPath);
      yield* fs.makeDirectory(recordPath);
      assert.isFalse(yield* store.record([entry("q4")]));
      assert.isFalse(yield* store.markReopened([{ requestId: "q3", by: "card" }]));
      assert.isTrue((yield* fs.stat(recordPath)).type === "Directory");
    }),
  ),
);
