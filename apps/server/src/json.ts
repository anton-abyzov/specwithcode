import * as Schema from "effect/Schema";

/** Untyped external JSON stays unknown until its caller validates the domain schema. */
export const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeCompactJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export function stringifyJson(value: unknown, replacer?: null, space?: number | string): string {
  return space === undefined
    ? encodeCompactJson(value)
    : Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space }))(value);
}
