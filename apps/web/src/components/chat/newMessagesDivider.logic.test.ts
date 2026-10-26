import { describe, expect, it } from "vite-plus/test";
import { firstUnreadRowId } from "./newMessagesDivider.logic";

const message = (
  id: string,
  createdAt: string,
  role: "user" | "assistant",
  createdBy?: "user" | "agent",
) => ({
  id,
  kind: "message",
  message: { role, createdAt, ...(createdBy ? { createdBy } : {}) },
});

const ROWS = [
  message("asked", "2026-10-26T03:00:00Z", "user", "user"),
  { id: "work", kind: "work" },
  message("answer", "2026-10-26T03:01:00Z", "assistant"),
  message("coordinator", "2026-10-26T03:05:00Z", "user", "agent"),
  message("reply", "2026-10-26T03:06:00Z", "assistant"),
];

describe("firstUnreadRowId", () => {
  it("marks the first message someone else wrote after the last visit", () => {
    expect(firstUnreadRowId(ROWS, "2026-10-26T03:02:00Z")).toBe("coordinator");
    expect(firstUnreadRowId(ROWS, "2026-10-26T03:00:30Z")).toBe("answer");
  });

  it("marks nothing when everything was read, or the thread was never visited", () => {
    expect(firstUnreadRowId(ROWS, "2026-10-26T03:10:00Z")).toBeNull();
    expect(firstUnreadRowId(ROWS, null)).toBeNull();
    expect(firstUnreadRowId(ROWS, undefined)).toBeNull();
    expect(firstUnreadRowId(ROWS, "not a date")).toBeNull();
  });

  it("marks nothing after the person's own newer message: they were here", () => {
    expect(firstUnreadRowId(ROWS, "2026-10-26T02:59:00Z")).toBeNull();
  });
});
