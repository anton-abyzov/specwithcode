/**
 * What the card sends passes the check an MCP server runs on it (1493):
 * `Server.elicitInput` in the MCP SDK validates the answer against the form's
 * schema and throws when it fails, which ends the server's tool call.
 */
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { mcpElicitationSentValues } from "@specweave-studio/shared/mcpElicitationDateTime";
import {
  parseMcpElicitationSchema,
  validateMcpElicitationContent,
} from "@specweave-studio/shared/mcpElicitationForm";
import { describe, expect, it } from "vite-plus/test";

const schema = {
  type: "object",
  properties: {
    at: { type: "string", format: "date-time" },
    mail: { type: "string", format: "email" },
    day: { type: "string", format: "date" },
    tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1 },
  },
} as const;

const server = new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(schema as never);
const parsed = parseMcpElicitationSchema(schema);
if (!parsed.ok) throw new Error(parsed.reason);
const fields = parsed.fields;

/** The card's own path: map date-time entries, then check, then send. */
const send = (values: Record<string, unknown>) =>
  validateMcpElicitationContent(fields, mcpElicitationSentValues(fields, values));

describe("MCP SDK validator (1493)", () => {
  it("accepts a datetime-local entry once the card sends it", () => {
    // The browser's datetime-local value, as the card holds it.
    expect(server({ at: "2026-11-25T10:00" }).valid).toBe(false);
    const sent = send({ at: "2026-11-25T10:00" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(server(sent.content)).toMatchObject({ valid: true });
  });

  it("accepts a trimmed email and an empty optional multi-select", () => {
    expect(server({ mail: " a@b.co " }).valid).toBe(false);
    const sent = send({ mail: " a@b.co ", tags: [], day: "2028-02-29" });
    expect(sent).toEqual({ ok: true, content: { mail: "a@b.co", day: "2028-02-29" } });
    if (!sent.ok) return;
    expect(server(sent.content)).toMatchObject({ valid: true });
  });

  it("refuses on the card every date-time the server would refuse", () => {
    for (const at of [
      "2026-11-25T10:00:00",
      "2026-02-30T10:00:00Z",
      "2026-11-25T24:00:00Z",
      "2026-11-25T10:00:00+24:00",
    ]) {
      expect(server({ at }).valid).toBe(false);
      expect(validateMcpElicitationContent(fields, { at }).ok).toBe(false);
    }
  });
});
