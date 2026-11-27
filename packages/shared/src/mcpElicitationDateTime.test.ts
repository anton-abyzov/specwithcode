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
