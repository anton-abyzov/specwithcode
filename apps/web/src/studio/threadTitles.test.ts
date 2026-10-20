import { describe, expect, it } from "vite-plus/test";

import { canRenameChat, checkChatTitle } from "./threadTitles";

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
