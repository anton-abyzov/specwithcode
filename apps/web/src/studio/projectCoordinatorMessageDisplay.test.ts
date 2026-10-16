import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@specweave-studio/contracts";
import {
  projectCoordinatorMessageDisplay,
  projectMessageAuthor,
  isWorkerCompletionWake,
  projectReportMessageIds,
  projectSystemNotice,
  returnedFollowUpIds,
  routedRepliesForThread,
  routedReplyNotes,
} from "./projectCoordinatorMessageDisplay";

const project = { id: "project", environmentId: "host" };
const worker = {
  id: ThreadId.make("worker"),
  title: "Calendar work",
  projectId: "project",
  environmentId: "host",
  deletedAt: null,
};
const prefix =
  "User follow-up from selected worker worker. Review that thread and decide whether to reuse it or route elsewhere.\n\n";
const original = "  Keep **all** formatting.\n\n";
const message = {
  id: "coordinator-send:project:command",
  role: "user",
  createdBy: "user",
  senderThreadId: "worker",
  text: prefix + original,
};

describe("coordinator follow-up presentation", () => {
  it("removes one verified server prefix without mutating the stored message", () => {
    const stored = Object.freeze({ ...message, text: prefix + prefix + original });
    expect(projectCoordinatorMessageDisplay(stored, project, [worker])).toEqual({
      text: prefix + original,
      sourceThread: worker,
    });
    expect(stored.text).toBe(prefix + prefix + original);
  });
  it("removes the prefix that names the message for forwarding", () => {
    const named = `User follow-up from selected worker worker, message ${message.id}. Review that thread and decide whether to reuse it or route elsewhere.\n\n`;
    expect(
      projectCoordinatorMessageDisplay({ ...message, text: named + original }, project, [worker]),
    ).toEqual({ text: original, sourceThread: worker });
    // Another message's ID is not this message's wrapper.
    expect(
      projectCoordinatorMessageDisplay(
        {
          ...message,
          text: named.replace(message.id, "coordinator-send:project:other") + original,
        },
        project,
        [worker],
      ).sourceThread,
    ).toBeNull();
  });
  it("accepts attachment-bound receipt IDs and preserves whitespace", () => {
    expect(
      projectCoordinatorMessageDisplay({ ...message, id: message.id + ":fingerprint" }, project, [
        worker,
      ]),
    ).toEqual({ text: original, sourceThread: worker });
  });
  it.each([
    ["ordinary typed text", { id: "ordinary-message" }],
    ["another project's receipt", { id: "coordinator-send:project-other:command" }],
    ["missing command identity", { id: "coordinator-send:project:" }],
    ["blank command identity", { id: "coordinator-send:project:  " }],
    ["agent origin", { createdBy: "agent" }],
    ["assistant role", { role: "assistant" }],
    ["missing sender", { senderThreadId: undefined }],
    ["unknown sender", { senderThreadId: "unknown" }],
    [
      "mismatched prefix sender",
      { text: prefix.replace("worker worker.", "worker another.") + original },
    ],
    ["edited server preamble", { text: prefix.replace("Review", "Please review") + original }],
    ["prefix inside user prose", { text: "Quote:\n" + prefix + original }],
    ["ordinary follow-up", { text: original }],
  ])("keeps %s verbatim", (_name, overrides) => {
    const input = { ...message, ...overrides };
    expect(projectCoordinatorMessageDisplay(input, project, [worker])).toEqual({
      text: input.text,
      sourceThread: null,
    });
  });
  it.each([
    ["foreign project", { projectId: "other" }],
    ["foreign host", { environmentId: "other" }],
    ["deleted worker", { deletedAt: "2026-10-09T00:00:00Z" }],
  ])("does not trust a %s with the same ID", (_name, overrides) => {
    expect(
      projectCoordinatorMessageDisplay(message, project, [{ ...worker, ...overrides }]),
    ).toEqual({ text: message.text, sourceThread: null });
  });
});

describe("coordinator message author", () => {
  it("labels the coordinator's own replies as the coordinator, not a worker", () => {
    expect(projectMessageAuthor({ role: "assistant", createdBy: "agent" })).toBe("Coordinator");
    expect(projectMessageAuthor({ role: "user", createdBy: "agent" })).toBe(
      "Message from a worker",
    );
    expect(projectMessageAuthor({ role: "user", createdBy: "user" })).toBe("You");
  });
});

describe("coordinator system notices", () => {
  it("hides a worker's completion wake; its thread status and a notification announce it", () => {
    expect(
      isWorkerCompletionWake({
        delegatedCompletion: { taskIds: ["node:delegated-task:command%3Amcp-1"] },
      }),
    ).toBe(true);
    expect(isWorkerCompletionWake({ delegatedCompletion: { taskIds: [] } })).toBe(false);
    expect(isWorkerCompletionWake({})).toBe(false);
    expect(
      isWorkerCompletionWake({
        notification: {
          summary: "[Fix flaky test](studio://thread/env-m1/t1) on Studio B reported back.",
        },
      }),
    ).toBe(true);
    expect(
      isWorkerCompletionWake({
        notification: { summary: "Lost contact with [T](studio://thread/e/t) on B." },
      }),
    ).toBe(false);
  });

  it("shows a background notification's summary", () => {
    expect(projectSystemNotice({ notification: { summary: "Background activity updated" } })).toBe(
      "Background activity updated",
    );
    expect(projectSystemNotice({})).toBeNull();
  });
});

describe("a thread's record of what was typed in it", () => {
  const other = { ...worker, id: ThreadId.make("other"), title: "Other work" };
  const fromOther = {
    ...message,
    id: "coordinator-send:project:other",
    senderThreadId: "other",
    text: prefix.replace("worker worker.", "worker other.") + "Elsewhere",
  };
  const answer = {
    id: "a1",
    role: "assistant",
    createdBy: "agent",
    text: "**Sent** to\n[Calendar work](studio://thread/worker), `as asked`.",
  };
  it("lists only this thread's messages, in order, each with the coordinator's next answer", () => {
    const second = { ...message, id: "coordinator-send:project:second", text: prefix + "Again" };
    expect(
      routedRepliesForThread(
        [
          { ...message, createdAt: "2026-10-10T10:00:00.000Z" },
          { id: "s", role: "assistant", createdBy: "agent", text: "typing", streaming: true },
          answer,
          fromOther,
          { id: "a2", role: "assistant", createdBy: "agent", text: "Sent to Other work." },
          second,
        ],
        project,
        worker,
      ),
    ).toEqual([
      {
        id: message.id,
        text: original,
        createdAt: "2026-10-10T10:00:00.000Z",
        answer: "Sent to Calendar work, as asked.",
        answerThreadIds: ["worker"],
      },
      { id: second.id, text: "Again", createdAt: null, answer: null, answerThreadIds: [] },
    ]);
  });
  it("notes only a message that went elsewhere or has not been routed yet", () => {
    const reply = (id: string, answer: string | null, answerThreadIds: string[] = []) => ({
      id,
      text: ` ${id} words `,
      createdAt: null,
      answer,
      answerThreadIds,
    });
    const notes = routedReplyNotes(
      [
        reply("here", "Sent to Calendar work.", ["worker"]),
        reply("delivered", "Done."),
        reply("elsewhere", "Sent to Other work.", [other.id]),
        reply("waiting", null),
        reply("kept", "It is not blocked."),
      ],
      [{ role: "user", senderThreadId: "coord", text: "delivered words" }],
      "worker",
      "coord",
    );
    expect(notes).toEqual([
      // Answered with a link back here: still on its way.
      { id: "here", text: "here words", kind: "pending", targetThreadId: null },
      { id: "elsewhere", text: "elsewhere words", kind: "sent", targetThreadId: "other" },
      { id: "waiting", text: "waiting words", kind: "pending", targetThreadId: null },
      { id: "kept", text: "kept words", kind: "answered", targetThreadId: null },
    ]);
  });
  it("does not borrow an answer given to a later message", () => {
    expect(
      routedRepliesForThread(
        [message, { id: "u", role: "user", createdBy: "user", text: "Unrelated" }, answer],
        project,
        worker,
      )[0]?.answer,
    ).toBeNull();
  });
  it("keeps a long answer to one short line", () => {
    const long = { ...answer, text: "x".repeat(400) };
    const shown = routedRepliesForThread([message, long], project, worker)[0]?.answer;
    expect(shown).toHaveLength(240);
    expect(shown?.endsWith("…")).toBe(true);
  });
  it("ignores coordinator messages that were not typed in a thread", () => {
    expect(
      routedRepliesForThread(
        [{ id: "plain", role: "user", createdBy: "user", text: "Start a thread" }, answer],
        project,
        worker,
      ),
    ).toEqual([]);
  });
});

describe("coordinator messages that carry a worker's report", () => {
  const completion = { taskIds: ["node:delegated-task:a"] };
  it("marks a worker's message and the coordinator's relay after a completion", () => {
    const ids = projectReportMessageIds([
      { id: "ask", role: "user", createdBy: "user" },
      { id: "plan", role: "assistant", createdBy: "agent" },
      { id: "wake", role: "user", createdBy: "system", delegatedCompletion: completion },
      { id: "relay", role: "assistant", createdBy: "agent" },
      { id: "relay-more", role: "assistant", createdBy: "agent" },
      { id: "follow-up", role: "user", createdBy: "user" },
      { id: "answer", role: "assistant", createdBy: "agent" },
      { id: "worker", role: "user", createdBy: "agent" },
      { id: "relay-worker", role: "assistant", createdBy: "agent" },
    ]);
    expect([...ids]).toEqual(["relay", "relay-more", "worker", "relay-worker"]);
  });

  it("leaves a conversation with no reports alone", () => {
    expect(
      projectReportMessageIds([
        { id: "ask", role: "user", createdBy: "user" },
        { id: "answer", role: "assistant", createdBy: "agent" },
      ]).size,
    ).toBe(0);
  });
});

describe("follow-ups passed back to their own worker", () => {
  const reply = (id: string, text: string) => ({
    id,
    role: "assistant",
    createdBy: "agent",
    text,
  });
  const followUp = (id: string) => ({
    ...message,
    id: `coordinator-send:project:${id}`,
    text: `User follow-up from selected worker worker, message coordinator-send:project:${id}. Review that thread and decide whether to reuse it or route elsewhere.\n\nmarquee promo?`,
  });

  it("leaves out a follow-up the coordinator only sent back to the same worker, with its reply", () => {
    const messages = [
      followUp("a"),
      reply("r1", "I passed your question to [Calendar work](studio://thread/worker)."),
    ];
    expect([...returnedFollowUpIds(messages, project, [worker])]).toEqual([
      "coordinator-send:project:a",
      "r1",
    ]);
  });

  it("keeps a follow-up moved to another worker, answered here, or not answered yet", () => {
    const messages = [
      followUp("moved"),
      reply("r1", "Moved to [Release](studio://thread/other)."),
      followUp("answered"),
      reply("r2", "The tile is 1400 by 560."),
      followUp("waiting"),
    ];
    expect(returnedFollowUpIds(messages, project, [worker]).size).toBe(0);
  });

  it("leaves the user's own coordinator messages alone", () => {
    const messages = [
      { ...message, senderThreadId: undefined, text: "Start a worker" },
      reply("r1", "Started [Calendar work](studio://thread/worker)."),
    ];
    expect(returnedFollowUpIds(messages, project, [worker]).size).toBe(0);
  });
});
