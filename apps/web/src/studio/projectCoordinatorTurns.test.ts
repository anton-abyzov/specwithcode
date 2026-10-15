import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { coordinatorTurnLayout, formatConversationSeparator } from "./projectCoordinatorTurns";

const message = (
  id: string,
  role: string,
  createdAt: unknown,
  updatedAt: unknown = createdAt,
  streaming = false,
) => ({ id, role, createdAt, updatedAt, streaming });

describe("coordinatorTurnLayout", () => {
  it("summarizes a turn above its first reply and puts the actions on its last", () => {
    const layout = coordinatorTurnLayout([
      message("u1", "user", "2026-10-11T21:53:00.000Z"),
      message("a1", "assistant", "2026-10-11T21:53:05.000Z"),
      message("a2", "assistant", "2026-10-11T21:53:10.000Z", "2026-10-11T21:53:14.000Z"),
    ]);
    expect(layout.get("u1")).toEqual({
      separatorAt: "2026-10-11T21:53:00.000Z",
      workedFor: null,
      endsTurn: false,
      settledAt: "2026-10-11T21:53:00.000Z",
    });
    expect(layout.get("a1")).toEqual({
      separatorAt: null,
      workedFor: "Worked for 14s",
      endsTurn: false,
      settledAt: "2026-10-11T21:53:05.000Z",
    });
    expect(layout.get("a2")).toMatchObject({
      endsTurn: true,
      settledAt: "2026-10-11T21:53:14.000Z",
    });
  });

  it("reads Effect DateTime and Date values the projection carries", () => {
    const layout = coordinatorTurnLayout([
      message("u1", "user", DateTime.makeUnsafe("2026-10-11T21:53:00.000Z")),
      message("a1", "assistant", new Date("2026-10-11T21:53:30.000Z")),
    ]);
    expect(layout.get("u1")?.separatorAt).toBe("2026-10-11T21:53:00.000Z");
    expect(layout.get("a1")).toMatchObject({ workedFor: "Worked for 30s", endsTurn: true });
  });

  it("lets a notice take a separator without splitting the turn around it", () => {
    const layout = coordinatorTurnLayout([
      message("u1", "user", "2026-10-11T10:00:00.000Z"),
      message("a1", "assistant", "2026-10-11T10:00:10.000Z"),
      { ...message("n1", "assistant", "2026-10-11T11:30:00.000Z"), notice: true },
      message("a2", "assistant", "2026-10-11T11:30:05.000Z"),
    ]);
    expect(layout.get("n1")).toMatchObject({
      separatorAt: "2026-10-11T11:30:00.000Z",
      workedFor: null,
      endsTurn: false,
    });
    expect(layout.get("a1")).toMatchObject({ endsTurn: false });
    expect(layout.get("a2")).toMatchObject({ endsTurn: true });
  });

  it("ignores messages without a time", () => {
    const layout = coordinatorTurnLayout([
      message("u1", "user", undefined),
      message("a1", "assistant", undefined),
    ]);
    expect(layout.get("u1")).toMatchObject({ separatorAt: null, settledAt: null });
    expect(layout.get("a1")).toMatchObject({ workedFor: null, endsTurn: true });
  });

  it("waits for a streaming reply before timing or offering actions", () => {
    const layout = coordinatorTurnLayout([
      message("u1", "user", "2026-10-11T21:53:00.000Z"),
      message("a1", "assistant", "2026-10-11T21:53:05.000Z", "2026-10-11T21:53:09.000Z", true),
    ]);
    expect(layout.get("a1")).toMatchObject({ workedFor: null, endsTurn: false });
  });

  it("starts a new separator after a long pause", () => {
    const layout = coordinatorTurnLayout([
      message("u1", "user", "2026-10-11T10:00:00.000Z"),
      message("a1", "assistant", "2026-10-11T10:00:20.000Z"),
      message("u2", "user", "2026-10-11T11:30:00.000Z"),
    ]);
    expect(layout.get("a1")?.separatorAt).toBeNull();
    expect(layout.get("u2")?.separatorAt).toBe("2026-10-11T11:30:00.000Z");
  });
});

describe("formatConversationSeparator", () => {
  const now = new Date(2026, 9, 11, 23, 0).getTime();
  const clock = () => "9:53 PM";
  it("names today and yesterday", () => {
    expect(
      formatConversationSeparator(new Date(2026, 9, 11, 21, 53).toISOString(), clock, now),
    ).toBe("Today 9:53 PM");
    expect(
      formatConversationSeparator(new Date(2026, 9, 10, 21, 53).toISOString(), clock, now),
    ).toBe("Yesterday 9:53 PM");
  });
  it("names the weekday within a week", () => {
    expect(
      formatConversationSeparator(new Date(2026, 9, 5, 21, 53).toISOString(), clock, now),
    ).toMatch(/^[A-Z][a-z]+day 9:53 PM$/);
  });
  it("dates older messages", () => {
    const label = formatConversationSeparator(
      new Date(2026, 8, 25, 21, 53).toISOString(),
      clock,
      now,
    );
    expect(label).toMatch(/25/);
    expect(label.endsWith("9:53 PM")).toBe(true);
  });
});
