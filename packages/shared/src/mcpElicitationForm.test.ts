import { describe, expect, it } from "vite-plus/test";

import {
  MCP_ELICITATION_MAX_FIELDS,
  mcpElicitationInitialValues,
  parseMcpElicitationSchema,
  validateMcpElicitationContent,
  type McpElicitationField,
} from "./mcpElicitationForm.ts";

const fieldsOf = (schema: unknown): ReadonlyArray<McpElicitationField> => {
  const parsed = parseMcpElicitationSchema(schema);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.fields;
};

const everyType = {
  type: "object",
  properties: {
    name: { type: "string", title: "Repository", description: "Type it to confirm", minLength: 2 },
    email: { type: "string", format: "email" },
    site: { type: "string", format: "uri" },
    day: { type: "string", format: "date" },
    at: { type: "string", format: "date-time" },
    count: { type: "integer", minimum: 1, maximum: 5, default: 2 },
    ratio: { type: "number" },
    sure: { type: "boolean", default: true },
    color: { type: "string", enum: ["r", "g"], enumNames: ["Red", "Green"], default: "g" },
    size: { type: "string", oneOf: [{ const: "s", title: "Small" }, { const: "l" }] },
    tags: {
      type: "array",
      items: { type: "string", enum: ["a", "b", "c"] },
      minItems: 1,
      maxItems: 2,
      default: ["a"],
    },
    labels: { type: "array", items: { anyOf: [{ const: "x", title: "Ex" }] } },
  },
  required: ["name", "count", "tags"],
};

describe("parseMcpElicitationSchema", () => {
  it("maps every MCP field type with titles, formats, limits and defaults", () => {
    const fields = fieldsOf(everyType);
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
    expect(fields.map((field) => field.key)).toEqual(Object.keys(everyType.properties));
    expect(byKey.name).toMatchObject({
      kind: "text",
      title: "Repository",
      description: "Type it to confirm",
      required: true,
      minLength: 2,
    });
    expect(byKey.email).toMatchObject({ kind: "text", format: "email", required: false });
    expect(byKey.site).toMatchObject({ kind: "text", format: "uri" });
    expect(byKey.day).toMatchObject({ kind: "text", format: "date" });
    expect(byKey.at).toMatchObject({ kind: "text", format: "date-time" });
    expect(byKey.count).toMatchObject({
      kind: "number",
      integer: true,
      minimum: 1,
      maximum: 5,
      default: 2,
    });
    expect(byKey.ratio).toMatchObject({ kind: "number", integer: false });
    expect(byKey.sure).toMatchObject({ kind: "boolean", default: true });
    expect(byKey.color).toMatchObject({
      kind: "select",
      default: "g",
      options: [
        { value: "r", label: "Red" },
        { value: "g", label: "Green" },
      ],
    });
    expect(byKey.size).toMatchObject({
      kind: "select",
      options: [
        { value: "s", label: "Small" },
        { value: "l", label: "l" },
      ],
    });
    expect(byKey.tags).toMatchObject({
      kind: "multiselect",
      minItems: 1,
      maxItems: 2,
      default: ["a"],
    });
    expect(byKey.labels).toMatchObject({
      kind: "multiselect",
      options: [{ value: "x", label: "Ex" }],
    });
  });

  it("reads a missing schema or one without fields as a confirmation", () => {
    expect(parseMcpElicitationSchema(undefined)).toEqual({ ok: true, fields: [] });
    expect(parseMcpElicitationSchema({ type: "object", properties: {} })).toEqual({
      ok: true,
      fields: [],
    });
  });

  it("refuses a form it cannot show as a whole", () => {
    const refused = [
      "not an object",
      { type: "array" },
      { type: "object", properties: { nested: { type: "object", properties: {} } } },
      { type: "object", properties: { when: { type: "string", format: "time" } } },
      { type: "object", properties: { free: { type: "array", items: { type: "string" } } } },
      { type: "object", properties: { bad: { type: "string", enum: [1, 2] } } },
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: MCP_ELICITATION_MAX_FIELDS + 1 }, (_, i) => [
            `f${i}`,
            { type: "string" },
          ]),
        ),
      },
      { type: "object", properties: { big: { type: "string", description: "x".repeat(70_000) } } },
    ];
    for (const schema of refused) expect(parseMcpElicitationSchema(schema).ok).toBe(false);
  });

  it("drops a default that is not one of the choices", () => {
    const [field] = fieldsOf({
      type: "object",
      properties: { color: { type: "string", enum: ["r"], default: "blue" } },
    });
    expect(field).not.toHaveProperty("default");
  });
});

describe("validateMcpElicitationContent", () => {
  const fields = fieldsOf(everyType);

  it("pre-fills defaults", () => {
    expect(mcpElicitationInitialValues(fields)).toMatchObject({
      count: 2,
      sure: true,
      color: "g",
      tags: ["a"],
      labels: [],
      name: undefined,
    });
  });

  it("returns typed content, leaves empty optional fields out and drops unknown keys", () => {
    const result = validateMcpElicitationContent(fields, {
      ...mcpElicitationInitialValues(fields),
      name: "octo/repo",
      count: "3",
      ratio: "",
      email: "",
      extra: "dropped",
    });
    expect(result).toEqual({
      ok: true,
      content: { name: "octo/repo", count: 3, sure: true, color: "g", tags: ["a"] },
    });
  });

  it("enforces required fields, formats, limits and choices", () => {
    const result = validateMcpElicitationContent(fields, {
      name: "x",
      email: "nope",
      site: "not a url",
      day: "2026-02-30",
      at: "tomorrow",
      count: "9",
      ratio: "1.5",
      sure: "yes",
      color: "blue",
      size: "m",
      tags: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).toSorted()).toEqual(
      ["name", "email", "site", "day", "at", "count", "sure", "color", "size", "tags"].toSorted(),
    );
    expect(validateMcpElicitationContent(fields, { count: 1, tags: ["a"] })).toMatchObject({
      ok: false,
      errors: { name: "Required." },
    });
    expect(
      validateMcpElicitationContent(fields, { name: "ok", count: 2.5, tags: ["a", "b", "c"] }),
    ).toMatchObject({
      ok: false,
      errors: { count: "Enter a whole number.", tags: "Choose at most 2." },
    });
  });

  it("accepts valid formats", () => {
    const result = validateMcpElicitationContent(fields, {
      name: "ok",
      count: 1,
      tags: ["b"],
      email: "a@example.com",
      site: "https://example.com/x",
      day: "2026-11-24",
      at: "2026-11-24T10:00:00Z",
    });
    expect(result.ok).toBe(true);
  });

  it("knows leap days", () => {
    const [day] = fieldsOf({ type: "object", properties: { day: { type: "string", format: "date" } } });
    expect(validateMcpElicitationContent([day!], { day: "2028-02-29" }).ok).toBe(true);
    expect(validateMcpElicitationContent([day!], { day: "2026-02-29" }).ok).toBe(false);
    expect(validateMcpElicitationContent([day!], { day: "2026-13-01" }).ok).toBe(false);
  });

  it("sends empty content for a confirmation", () => {
    expect(validateMcpElicitationContent([], { anything: 1 })).toEqual({ ok: true, content: {} });
  });
});
