import { expect, it } from "vite-plus/test";

import { chatFolderProjectTitle } from "./TurnChatIntoProject";

it("names the project after the chat, or its folder when the chat has no title", () => {
  expect(chatFolderProjectTitle("Plan a trip", "/s/2026-10-17-plan-a-trip-a1b2")).toBe(
    "Plan a trip",
  );
  expect(chatFolderProjectTitle("  ", "/s/2026-10-17-plan-a-trip-a1b2/")).toBe(
    "2026-10-17-plan-a-trip-a1b2",
  );
});
