import { ScheduledTaskId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { messageSentByPerson, withMessageSenderNote } from "./messageSenderNote.ts";

const agent = {
  createdBy: "agent",
  creationSource: "mcp",
  senderThreadId: ThreadId.make("thread-a"),
} as const;

describe("withMessageSenderNote", () => {
  it("leaves slash commands and skill mentions from an agent as sent", () => {
    expect(withMessageSenderNote(agent, "/compact")).toBe("/compact");
    expect(withMessageSenderNote(agent, "  /goal ship it")).toBe("  /goal ship it");
    expect(withMessageSenderNote(agent, "$deploy staging")).toBe("$deploy staging");
  });

  it("notes an agent's text that only mentions a command later", () => {
    expect(withMessageSenderNote(agent, "Please run /compact")).toBe(
      '[SpecWithCode: the agent in thread "thread-a" sent this message, not the person using this chat.]\n\nPlease run /compact',
    );
  });

  it("leaves a person's message unchanged", () => {
    expect(withMessageSenderNote({ createdBy: "user", creationSource: "mobile" }, "Hi")).toBe("Hi");
  });

  it("adds no note to server text such as a continuation", () => {
    expect(withMessageSenderNote({ createdBy: "agent", creationSource: "server" }, "Go on")).toBe(
      "Go on",
    );
  });
});

describe("messageSentByPerson", () => {
  it("counts only a person's own message", () => {
    expect(messageSentByPerson({ createdBy: "user", creationSource: "web" })).toBe(true);
    expect(messageSentByPerson({ createdBy: "user", creationSource: "mobile" })).toBe(true);
    expect(messageSentByPerson({ createdBy: "user", creationSource: "server" })).toBe(true);
    expect(messageSentByPerson(agent)).toBe(false);
    expect(messageSentByPerson({ createdBy: "system", creationSource: "server" })).toBe(false);
    expect(
      messageSentByPerson({
        createdBy: "user",
        creationSource: "server",
        scheduledTaskId: ScheduledTaskId.make("routine"),
      }),
    ).toBe(false);
    expect(
      messageSentByPerson({
        createdBy: "user",
        creationSource: "mcp",
        senderThreadId: ThreadId.make("thread-a"),
      }),
    ).toBe(false);
  });
});
