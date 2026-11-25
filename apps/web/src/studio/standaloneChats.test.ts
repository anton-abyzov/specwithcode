import { describe, expect, it } from "vite-plus/test";

import {
  blockedHelpersOf,
  chatRequester,
  helperChatGroupLabel,
  helperChatOrigin,
  requesterProject,
} from "./standaloneChats";

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
      requesterProject(
        { origin: { environmentId: "m4", parentThreadRef: { threadId: "worker" } } },
        input,
      ),
    ).toBe("specweave");
  });

  it("leaves a person's chat, a chat's chat and an unknown requester in Chats", () => {
    expect(requesterProject({}, input)).toBeUndefined();
    expect(
      requesterProject(
        { origin: { parentThreadRef: { environmentId: "m4", threadId: "chat" } } },
        input,
      ),
    ).toBeUndefined();
    expect(
      requesterProject(
        { origin: { parentThreadRef: { environmentId: "m4", threadId: "gone" } } },
        input,
      ),
    ).toBeUndefined();
  });
});

describe("helper chats another machine's thread started", () => {
  const origin = {
    kind: "fleet_machine",
    machineLabel: "M5",
    environmentId: "m5",
    parentProjectLabel: "specweave",
    parentThreadRef: { environmentId: "m5", threadId: "thread:delegated-task:worker" },
  };

  it("names the requesting project, the loaded one first, never No project", () => {
    expect(helperChatOrigin({ origin }, undefined)).toEqual({
      projectName: "specweave",
      fromMachine: "M5",
    });
    expect(helperChatOrigin({ origin }, "specweave umbrella")?.projectName).toBe(
      "specweave umbrella",
    );
    // A person's chat, and a helper from a machine that sent no project name.
    expect(helperChatOrigin({}, undefined)).toBeUndefined();
    expect(
      helperChatOrigin({ origin: { ...origin, parentProjectLabel: undefined } }, undefined),
    ).toBeUndefined();
    expect(helperChatOrigin({ origin: { ...origin, parentThreadRef: undefined } }, "x")).toBe(
      undefined,
    );
  });

  it("groups a helper whose requester is not loaded under From <project> on <machine>", () => {
    expect(helperChatGroupLabel({ origin })).toBe("From specweave on M5");
    expect(helperChatGroupLabel({ origin: { ...origin, machineLabel: undefined } })).toBe(
      "From specweave",
    );
    expect(helperChatGroupLabel({ origin: { ...origin, parentProjectLabel: undefined } })).toBe(
      "From M5",
    );
    expect(helperChatGroupLabel({})).toBeUndefined();
  });

  it("shows a blocked helper in the thread that started it and in that thread's root", () => {
    const helper = { environmentId: "win", id: "helper", origin };
    const other = {
      environmentId: "win",
      id: "other",
      origin: { ...origin, parentThreadRef: { environmentId: "m5", threadId: "someone-else" } },
    };
    const local = { environmentId: "m5", id: "local", origin };
    const lookup = (key: string) =>
      key === "m5:thread:delegated-task:worker"
        ? { lineage: { rootThreadId: "project-coordinator:p" } }
        : undefined;
    const input = { thread: lookup, blockerOf: () => "On win: run gh auth login" };
    const worker = { environmentId: "m5", id: "thread:delegated-task:worker" };
    expect(blockedHelpersOf(worker, [helper, other, local], input)).toEqual([
      { helper, blocker: "On win: run gh auth login" },
    ]);
    expect(
      blockedHelpersOf({ environmentId: "m5", id: "project-coordinator:p" }, [helper], input),
    ).toHaveLength(1);
    // Not on another machine's thread of the same id, and not once it is unblocked.
    expect(
      blockedHelpersOf({ environmentId: "m4", id: "project-coordinator:p" }, [helper], input),
    ).toEqual([]);
    expect(blockedHelpersOf(worker, [helper], { ...input, blockerOf: () => null })).toEqual([]);
  });
});

describe("chatRequester", () => {
  type T = {
    id: string;
    chat: boolean;
    projectId: string;
    origin?: Record<string, unknown> | undefined;
  };
  const worker: T = { id: "m5:worker", chat: false, projectId: "specweave" };
  const origin = {
    machineLabel: "M5",
    parentProjectLabel: "specweave",
    parentThreadRef: { environmentId: "m5", threadId: "worker" },
  };
  const helper: T = { id: "win:helper", chat: true, projectId: "scratch", origin };
  const input = (loaded: boolean) => ({
    isChat: (t: T) => t.chat,
    thread: (key: string) => (loaded && key === worker.id ? worker : undefined),
    project: (t: T) => (t.projectId === "specweave" ? { displayName: "specweave" } : undefined),
  });

  it("opens a helper from its project row, or groups it by the name its machine sent", () => {
    expect(chatRequester(helper, input(true))).toEqual({
      group: { displayName: "specweave" },
      label: "specweave",
    });
    expect(chatRequester(helper, input(false))).toEqual({ label: "From specweave on M5" });
    // A project's own thread, and a person's chat.
    expect(chatRequester(worker, input(true))).toBeUndefined();
    expect(chatRequester({ ...helper, origin: undefined }, input(true))).toBeUndefined();
  });
});
