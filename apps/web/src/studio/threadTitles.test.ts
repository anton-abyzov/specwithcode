import { describe, expect, it } from "vite-plus/test";

import { canRenameChat, checkChatTitle, threadRenameBlockedReason } from "./threadTitles";

describe("canRenameChat", () => {
  it("allows a chat the person started on a machine they may operate", () => {
    expect(canRenameChat({ createdBy: "user" }, true)).toBe(true);
  });
  it("refuses without the operate scope", () => {
    expect(canRenameChat({ createdBy: "user" }, false)).toBe(false);
  });
  it("refuses chats a coordinator names", () => {
    expect(canRenameChat({ createdBy: "agent" }, true)).toBe(false);
    expect(
      canRenameChat(
        { createdBy: "user", lineage: { relationshipToParent: "subagent" } as never },
        true,
      ),
    ).toBe(false);
  });
});

describe("checkChatTitle", () => {
  it("saves a trimmed new title", () => {
    expect(checkChatTitle("  Drive layout ", "Plan")).toEqual({
      kind: "valid",
      name: "Drive layout",
    });
  });
  it("saves nothing for the same title, untitled included", () => {
    expect(checkChatTitle(" Plan ", "Plan")).toEqual({ kind: "unchanged" });
    expect(checkChatTitle("", "")).toEqual({ kind: "unchanged" });
  });
  it("refuses a blank title", () => {
    expect(checkChatTitle("   ", "Plan")).toEqual({ kind: "invalid", error: "Enter a name." });
  });
});

describe("threadRenameBlockedReason", () => {
  const base = {
    canOperate: true,
    connection: { phase: "connected" },
    environmentId: "dd2fc230",
    machineLabel: "Ministorm",
  };

  it("allows a connected machine this browser may operate", () => {
    expect(threadRenameBlockedReason(base)).toBeNull();
  });

  it("names what stops the rename", () => {
    expect(threadRenameBlockedReason({ ...base, canOperate: false })).toBe(
      "This connection can't change threads on Ministorm.",
    );
    expect(threadRenameBlockedReason({ ...base, connection: { phase: "connecting" } })).toBe(
      "Ministorm isn't connected right now, so this thread can't be renamed.",
    );
    expect(threadRenameBlockedReason({ ...base, connection: null })).toContain("isn't connected");
    expect(
      threadRenameBlockedReason({
        ...base,
        connection: { phase: "disconnected", blockedReason: "authentication" },
      }),
    ).toContain("signed out of Ministorm");
  });

  it("never shows a machine's raw ID", () => {
    expect(threadRenameBlockedReason({ ...base, connection: null, machineLabel: "dd2fc230" })).toBe(
      "That machine isn't connected right now, so this thread can't be renamed.",
    );
    expect(
      threadRenameBlockedReason({
        ...base,
        connection: { phase: "disconnected", blockedReason: "authentication" },
        machineLabel: undefined,
      }),
    ).toBe(
      "This browser is signed out of that machine. Sign in to it again to rename this thread.",
    );
    expect(
      threadRenameBlockedReason({ ...base, canOperate: false, machineLabel: "dd2fc230" }),
    ).toBe("This connection can't change threads there.");
  });
});
