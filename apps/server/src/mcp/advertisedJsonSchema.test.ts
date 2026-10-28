import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema, compactJsonSchema } from "./advertisedJsonSchema.ts";

it("drops JSON noise, merges tagged unions, and retains declared nulls", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { anyOf: [{ type: "string" }, { type: "null" }] },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["url", "number"] },
              url: { type: "string" },
              number: { type: "integer" },
            },
            required: ["kind"],
          },
          { type: "null" },
        ],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("retains a declared optional null-only value", () => {
  const tool = Tool.make("clear", {
    parameters: Schema.Struct({ value: Schema.optional(Schema.Null) }),
  });
  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: { value: { type: "null" } },
  });
});

it("preserves numeric and mixed discriminator types", () => {
  const variant = (tag: string | number) => ({
    type: "object",
    properties: { kind: { type: typeof tag === "number" ? "number" : "string", enum: [tag] } },
    required: ["kind"],
  });
  expect(compactJsonSchema({ anyOf: [variant(1), variant(2)] })).toEqual({
    type: "object",
    properties: { kind: { type: "number", enum: [1, 2] } },
    required: ["kind"],
  });
  const mixed = { anyOf: [variant(1), variant("two")] };
  expect(compactJsonSchema(mixed)).toEqual(mixed);
});
