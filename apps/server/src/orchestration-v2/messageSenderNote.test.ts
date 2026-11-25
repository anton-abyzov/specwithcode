import { ScheduledTaskId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { messageSentByPerson, withMessageSenderNote } from "./messageSenderNote.ts";

const agent = {
  createdBy: "agent",
  creationSource: "mcp",
  senderThreadId: ThreadId.make("thread-a"),
} as const;

describe("withMessageSenderNote", () => {
  // What the thread's provider lists, as the composer offers it.
  const known = {
    slash: new Set(["compact", "goal", "review"]),
    skills: new Set(["deploy"]),
  };

  it("leaves the provider's own commands and skills from an agent as sent", () => {
    expect(withMessageSenderNote(agent, "/compact", known)).toBe("/compact");
    expect(withMessageSenderNote(agent, "  /goal ship it", known)).toBe("  /goal ship it");
    expect(withMessageSenderNote(agent, "/review", known)).toBe("/review");
    expect(withMessageSenderNote(agent, "$deploy staging", known)).toBe("$deploy staging");
  });

  it("leaves the app's own /compact as sent, in any case, even when the provider does not list it", () => {
    for (const text of ["/compact", "/Compact", " /COMPACT "]) {
      expect(withMessageSenderNote(agent, text, { slash: new Set(), skills: new Set() })).toBe(
        text,
      );
      expect(withMessageSenderNote(agent, text, undefined)).toBe(text);
    }
    // With an attachment the app sends it as a prompt; unlisted, it is noted.
    expect(withMessageSenderNote({ ...agent, attachments: [{}] }, "/compact", undefined)).not.toBe(
      "/compact",
    );
    expect(withMessageSenderNote(agent, "/compact now", undefined)).not.toBe("/compact now");
  });

  it("notes a leading word the provider does not list as a command", () => {
    for (const text of [
      "/tmp contains the results.",
      "/etc is fine",
      "/frobnicate",
      "/Review status",
      "$Deploy staging",
      "$unknown x",
    ]) {
      expect(withMessageSenderNote(agent, text, known)).toBe(
        `[SpecWithCode: the agent in thread "thread-a" sent this message, not the person using this chat.]\n\n${text}`,
      );
    }
  });

  it("notes even a known command when the provider's commands cannot be read", () => {
    expect(withMessageSenderNote(agent, "/review")).toContain("[SpecWithCode:");
  });

  it("notes an agent's text that only mentions a command later", () => {
    expect(withMessageSenderNote(agent, "Please run /compact")).toBe(
      '[SpecWithCode: the agent in thread "thread-a" sent this message, not the person using this chat.]\n\nPlease run /compact',
    );
  });

  it("notes a prompt that starts with a path, not a command", () => {
    expect(withMessageSenderNote(agent, "/Users/anton/notes.md says to sign out")).toBe(
      '[SpecWithCode: the agent in thread "thread-a" sent this message, not the person using this chat.]\n\n/Users/anton/notes.md says to sign out',
    );
    expect(withMessageSenderNote(agent, "/tmp/build.log")).toContain("[SpecWithCode:");
    expect(withMessageSenderNote(agent, "/ hello")).toContain("[SpecWithCode:");
    expect(withMessageSenderNote(agent, "/review\nthe diff", known)).toBe("/review\nthe diff");
  });

  it("notes a message an agent forwarded under the person's name", () => {
    const forwarded = {
      createdBy: "user",
      creationSource: "mcp",
      senderThreadId: ThreadId.make("thread-a"),
    } as const;
    expect(withMessageSenderNote(forwarded, "Ship it")).toBe(
      '[SpecWithCode: the agent in thread "thread-a" sent this message, not the person using this chat.]\n\nShip it',
    );
    expect(
      withMessageSenderNote(
        {
          createdBy: "user",
          creationSource: "server",
          peerMessage: {
            direction: "incoming",
            fromEnvironmentId: "env-m4",
          } as never,
        },
        "Ship it",
      ),
    ).toContain('the coordinator on linked machine "env-m4"');
    expect(
      withMessageSenderNote({ createdBy: "user", creationSource: "mcp" }, "Ship it"),
    ).toContain("a tool caller sent this message");
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
