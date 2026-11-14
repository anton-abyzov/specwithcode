import { describe, expect, it } from "vite-plus/test";

import { requesterProject } from "./standaloneChats";

describe("requesterProject", () => {
  const threads = new Map([
    ["m4:worker", { projectId: "specweave" }],
    ["m4:chat", { projectId: "scratch" }],
  ]);
  const input = {
    thread: (key: string) => threads.get(key),
    project: (thread: { projectId: string }) =>
      thread.projectId === "scratch" ? undefined : thread.projectId,
  };

  it("finds the project of the thread on another machine that asked for the chat", () => {
    const chat = { origin: { parentThreadRef: { environmentId: "m4", threadId: "worker" } } };
    expect(requesterProject(chat, input)).toBe("specweave");
    // An older origin names the machine beside the ref.
    expect(
      requesterProject({ origin: { environmentId: "m4", parentThreadRef: { threadId: "worker" } } }, input),
    ).toBe("specweave");
  });

  it("leaves a person's chat, a chat's chat and an unknown requester in Chats", () => {
    expect(requesterProject({}, input)).toBeUndefined();
    expect(
      requesterProject({ origin: { parentThreadRef: { environmentId: "m4", threadId: "chat" } } }, input),
    ).toBeUndefined();
    expect(
      requesterProject({ origin: { parentThreadRef: { environmentId: "m4", threadId: "gone" } } }, input),
    ).toBeUndefined();
  });
});
