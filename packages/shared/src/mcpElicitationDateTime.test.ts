// @effect-diagnostics globalDate:off -- The card works in this device's local zone, so the assertions read it through Date.
import { describe, expect, it } from "vite-plus/test";

import {
  isRfc3339DateTime,
  localInputToRfc3339,
  mcpElicitationCardValues,
  mcpElicitationSentValues,
  rfc3339ToLocalInput,
} from "./mcpElicitationDateTime.ts";
import { parseMcpElicitationSchema, type McpElicitationField } from "./mcpElicitationForm.ts";

const fieldsOf = (schema: unknown): ReadonlyArray<McpElicitationField> => {
  const parsed = parseMcpElicitationSchema(schema);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.fields;
};

describe("mcpElicitationDateTime (1493)", () => {
  it("writes a datetime-local value with seconds and the given offset", () => {
    expect(localInputToRfc3339("2026-11-25T10:00", -480)).toBe("2026-11-25T10:00:00-08:00");
    expect(localInputToRfc3339("2026-11-25T10:00:30", 330)).toBe("2026-11-25T10:00:30+05:30");
    expect(localInputToRfc3339("2026-11-25T10:00:30.5", -570)).toBe("2026-11-25T10:00:30.5-09:30");
    expect(localInputToRfc3339("2026-11-25T10:00", 0)).toBe("2026-11-25T10:00:00+00:00");
    expect(localInputToRfc3339("2026-11-25T10:00:00Z")).toBe("2026-11-25T10:00:00Z");
    for (const bad of ["tomorrow", "2026-02-30T10:00", "2026-11-25T25:00", "2026-11-25"])
      expect(localInputToRfc3339(bad, 0)).toBeUndefined();
  });

  it("uses the local offset by default and keeps the instant", () => {
    const sent = localInputToRfc3339("2026-07-01T09:15");
    expect(sent).toBeDefined();
    expect(isRfc3339DateTime(sent!)).toBe(true);
    expect(new Date(sent!).getTime()).toBe(new Date(2026, 6, 1, 9, 15).getTime());
  });

  it("shows a zoned value as the same instant in local time", () => {
    const shown = rfc3339ToLocalInput("2026-12-01T09:00:00Z");
    expect(shown).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(shown!).getTime()).toBe(Date.parse("2026-12-01T09:00:00Z"));
    expect(new Date(rfc3339ToLocalInput("2026-12-01T09:00:07+02:00")!).getTime()).toBe(
      Date.parse("2026-12-01T09:00:07+02:00"),
    );
    expect(rfc3339ToLocalInput("2026-12-01T09:00")).toBeUndefined();
    expect(rfc3339ToLocalInput("soon")).toBeUndefined();
  });

  it("round-trips what the card shows back to the same instant", () => {
    const value = "2026-03-08T10:30:00Z";
    expect(new Date(localInputToRfc3339(rfc3339ToLocalInput(value)!)!).getTime()).toBe(
      Date.parse(value),
    );
  });

  it("maps only date-time fields, and drops a default the card can't show", () => {
    const fields = fieldsOf({
      type: "object",
      properties: {
        at: { type: "string", format: "date-time", default: "2026-12-01T09:00:00Z" },
        bad: { type: "string", format: "date-time", default: "next week" },
        note: { type: "string", default: "2026-12-01T09:00" },
      },
    });
    const shown = mcpElicitationCardValues(fields, {
      at: "2026-12-01T09:00:00Z",
      bad: "next week",
      note: "2026-12-01T09:00",
    });
    expect(new Date(shown.at as string).getTime()).toBe(Date.parse("2026-12-01T09:00:00Z"));
    expect(shown.bad).toBeUndefined();
    expect(shown.note).toBe("2026-12-01T09:00");
    const sent = mcpElicitationSentValues(fields, {
      at: "2026-11-25T10:00",
      bad: "soon",
      note: "x",
    });
    expect(isRfc3339DateTime(sent.at as string)).toBe(true);
    expect(sent.bad).toBe("soon");
    expect(sent.note).toBe("x");
  });
});

describe("mcpElicitationDateTime across a clock change (1493)", () => {
  const inZone = <A>(zone: string, run: () => A): A => {
    const before = process.env.TZ;
    process.env.TZ = zone;
    try {
      return run();
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  };

  it("sends an untouched default exactly as the server gave it", () =>
    inZone("America/New_York", () => {
      // 01:30 happens twice on November 1, 2026 in New York; this is the second.
      const fields = fieldsOf({
        type: "object",
        properties: {
          late: { type: "string", format: "date-time", default: "2026-11-01T01:30:00-05:00" },
          fine: { type: "string", format: "date-time", default: "2026-12-01T09:00:00.250Z" },
        },
      });
      const shown = mcpElicitationCardValues(fields, {
        late: "2026-11-01T01:30:00-05:00",
        fine: "2026-12-01T09:00:00.250Z",
      });
      expect(shown.late).toBe("2026-11-01T01:30");
      expect(mcpElicitationSentValues(fields, shown)).toEqual({
        late: "2026-11-01T01:30:00-05:00",
        fine: "2026-12-01T09:00:00.250Z",
      });
      // An edit is read as local time again.
      expect(mcpElicitationSentValues(fields, { ...shown, late: "2026-11-01T02:00" }).late).toBe(
        "2026-11-01T02:00:00-05:00",
      );
    }));

  it("writes a time and offset that name the same instant", () =>
    inZone("America/New_York", () => {
      expect(new Date(2026, 6, 1, 12).getTimezoneOffset()).toBe(240);
      // Repeated hour: the earlier offset.
      const repeated = localInputToRfc3339("2026-11-01T01:30")!;
      expect(repeated).toMatch(/^2026-11-01T01:30:00-0[45]:00$/);
      expect(new Date(repeated).getTime()).toBe(new Date(2026, 10, 1, 1, 30).getTime());
      // Skipped hour: the time it became.
      const skipped = localInputToRfc3339("2026-03-08T02:30")!;
      expect(skipped).toBe("2026-03-08T03:30:00-04:00");
      expect(isRfc3339DateTime(skipped)).toBe(true);
    }));
});
