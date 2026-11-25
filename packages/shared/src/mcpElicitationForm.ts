/**
 * Reads the form an MCP server asks for (`elicitation/create` in form mode,
 * its `requestedSchema`) and checks what the person filled in. The server
 * handler and the web card both use it, so the card draws exactly the fields
 * the server will accept and the server re-checks what the card sends.
 *
 * MCP limits a form to a flat object of primitive fields: strings (with an
 * optional format), numbers and integers, booleans, single-select strings and
 * multi-select string arrays. Anything else is refused as a whole, never shown
 * in part.
 *
 * @module mcpElicitationForm
 */

/** A form larger than this, as JSON, is not shown. */
export const MCP_ELICITATION_SCHEMA_MAX_BYTES = 64 * 1024;
/** A form with more fields than this is not shown. */
export const MCP_ELICITATION_MAX_FIELDS = 50;

export type McpElicitationStringFormat = "email" | "uri" | "date" | "date-time";

export interface McpElicitationOption {
  readonly value: string;
  readonly label: string;
}

interface FieldBase {
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  readonly required: boolean;
}

export type McpElicitationField =
  | (FieldBase & {
      readonly kind: "text";
      readonly format?: McpElicitationStringFormat;
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly default?: string;
    })
  | (FieldBase & {
      readonly kind: "number";
      readonly integer: boolean;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly default?: number;
    })
  | (FieldBase & { readonly kind: "boolean"; readonly default?: boolean })
  | (FieldBase & {
      readonly kind: "select";
      readonly options: ReadonlyArray<McpElicitationOption>;
      readonly default?: string;
    })
  | (FieldBase & {
      readonly kind: "multiselect";
      readonly options: ReadonlyArray<McpElicitationOption>;
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly default?: ReadonlyArray<string>;
    });

export type McpElicitationValue = string | number | boolean | ReadonlyArray<string>;
export type McpElicitationContent = Readonly<Record<string, McpElicitationValue>>;

export type McpElicitationFormParse =
  | { readonly ok: true; readonly fields: ReadonlyArray<McpElicitationField> }
  | { readonly ok: false; readonly reason: string };

export type McpElicitationValidation =
  | { readonly ok: true; readonly content: McpElicitationContent }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

const FORMATS: ReadonlySet<string> = new Set(["email", "uri", "date", "date-time"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const optionalCount = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const optionalNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** `[{ const, title }]`, the titled form of a choice list. */
function titledOptions(value: unknown): ReadonlyArray<McpElicitationOption> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const options: McpElicitationOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.const !== "string") return null;
    options.push({ value: entry.const, label: optionalString(entry.title) ?? entry.const });
  }
  return options;
}

/** `enum`, labelled by the legacy `enumNames` when it has one name per value. */
function enumOptions(values: unknown, names: unknown): ReadonlyArray<McpElicitationOption> | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!values.every((value) => typeof value === "string")) return null;
  const labels =
    Array.isArray(names) &&
    names.length === values.length &&
    names.every((name) => typeof name === "string")
      ? (names as ReadonlyArray<string>)
      : undefined;
  return (values as ReadonlyArray<string>).map((value, index) => ({
    value,
    label: labels?.[index] ?? value,
  }));
}

function parseField(
  key: string,
  property: unknown,
  required: boolean,
): McpElicitationField | string {
  if (!isRecord(property)) return `Field "${key}" is not an object.`;
  const base: FieldBase = {
    key,
    title: optionalString(property.title) ?? key,
    ...(optionalString(property.description) === undefined
      ? {}
      : { description: property.description as string }),
    required,
  };
  switch (property.type) {
    case "string": {
      const options =
        property.enum !== undefined
          ? enumOptions(property.enum, property.enumNames)
          : property.oneOf !== undefined
            ? titledOptions(property.oneOf)
            : undefined;
      if (options === null) return `Field "${key}" has an unreadable list of choices.`;
      if (options !== undefined) {
        const fallback = typeof property.default === "string" ? property.default : undefined;
        return {
          ...base,
          kind: "select",
          options,
          ...(fallback !== undefined && options.some((option) => option.value === fallback)
            ? { default: fallback }
            : {}),
        };
      }
      if (property.format !== undefined && !FORMATS.has(String(property.format)))
        return `Field "${key}" asks for the unsupported format "${String(property.format)}".`;
      const minLength = optionalCount(property.minLength);
      const maxLength = optionalCount(property.maxLength);
      return {
        ...base,
        kind: "text",
        ...(property.format === undefined
          ? {}
          : { format: property.format as McpElicitationStringFormat }),
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(typeof property.default === "string" ? { default: property.default } : {}),
      };
    }
    case "number":
    case "integer": {
      const minimum = optionalNumber(property.minimum);
      const maximum = optionalNumber(property.maximum);
      const fallback = optionalNumber(property.default);
      return {
        ...base,
        kind: "number",
        integer: property.type === "integer",
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
        ...(fallback === undefined ? {} : { default: fallback }),
      };
    }
    case "boolean":
      return {
        ...base,
        kind: "boolean",
        ...(typeof property.default === "boolean" ? { default: property.default } : {}),
      };
    case "array": {
      const items = property.items;
      if (!isRecord(items)) return `Field "${key}" is a list without items.`;
      const options =
        items.enum !== undefined
          ? enumOptions(items.enum, items.enumNames)
          : items.anyOf !== undefined
            ? titledOptions(items.anyOf)
            : items.oneOf !== undefined
              ? titledOptions(items.oneOf)
              : null;
      if (options === null) return `Field "${key}" is a list without fixed choices.`;
      const minItems = optionalCount(property.minItems);
      const maxItems = optionalCount(property.maxItems);
      const values = new Set(options.map((option) => option.value));
      const fallback =
        Array.isArray(property.default) &&
        property.default.every((value) => typeof value === "string" && values.has(value))
          ? (property.default as ReadonlyArray<string>)
          : undefined;
      return {
        ...base,
        kind: "multiselect",
        options,
        ...(minItems === undefined ? {} : { minItems }),
        ...(maxItems === undefined ? {} : { maxItems }),
        ...(fallback === undefined ? {} : { default: fallback }),
      };
    }
    default:
      return `Field "${key}" has the unsupported type "${String(property.type)}".`;
  }
}

/** The fields of a form, or why it cannot be shown. A missing schema is a confirmation. */
export function parseMcpElicitationSchema(schema: unknown): McpElicitationFormParse {
  if (schema === undefined || schema === null) return { ok: true, fields: [] };
  if (!isRecord(schema)) return { ok: false, reason: "The form is not an object." };
  let size: number;
  try {
    size = JSON.stringify(schema).length;
  } catch {
    return { ok: false, reason: "The form cannot be read." };
  }
  if (size > MCP_ELICITATION_SCHEMA_MAX_BYTES)
    return { ok: false, reason: "The form is too large." };
  if (schema.type !== undefined && schema.type !== "object")
    return { ok: false, reason: "The form is not an object." };
  const properties = schema.properties ?? {};
  if (!isRecord(properties)) return { ok: false, reason: "The form's fields cannot be read." };
  const keys = Object.keys(properties);
  if (keys.length > MCP_ELICITATION_MAX_FIELDS)
    return { ok: false, reason: "The form has too many fields." };
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const fields: McpElicitationField[] = [];
  for (const key of keys) {
    if (key.trim() === "") return { ok: false, reason: "A field has no name." };
    const field = parseField(key, properties[key], required.has(key));
    if (typeof field === "string") return { ok: false, reason: field };
    fields.push(field);
  }
  return { ok: true, fields };
}

/** What a field starts with: the server's default, or empty. */
export function mcpElicitationInitialValues(
  fields: ReadonlyArray<McpElicitationField>,
): Record<string, McpElicitationValue | undefined> {
  const values: Record<string, McpElicitationValue | undefined> = {};
  for (const field of fields) {
    values[field.key] =
      field.kind === "boolean"
        ? (field.default ?? false)
        : field.kind === "multiselect"
          ? (field.default ?? [])
          : field.default;
  }
  return values;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function formatError(format: McpElicitationStringFormat, value: string): string | undefined {
  switch (format) {
    case "email":
      return EMAIL.test(value) ? undefined : "Enter an email address.";
    case "uri":
      try {
        new URL(value);
        return undefined;
      } catch {
        return "Enter a full web address.";
      }
    case "date": {
      const match = DATE.exec(value);
      if (match === null) return "Enter a date as YYYY-MM-DD.";
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
      return days !== undefined && day >= 1 && day <= days ? undefined : "Enter a real date.";
    }
    case "date-time":
      return DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : "Enter a date and time.";
  }
}

function checkField(
  field: McpElicitationField,
  raw: unknown,
): { readonly value?: McpElicitationValue; readonly error?: string } {
  const empty =
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "") ||
    (Array.isArray(raw) && raw.length === 0 && field.kind !== "multiselect");
  if (field.kind === "boolean") {
    if (raw === undefined || raw === null) return field.required ? { error: "Required." } : {};
    return typeof raw === "boolean" ? { value: raw } : { error: "Choose yes or no." };
  }
  if (field.kind === "multiselect") {
    const list = raw === undefined || raw === null ? [] : raw;
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string"))
      return { error: "Choose from the list." };
    const allowed = new Set(field.options.map((option) => option.value));
    if (!list.every((entry) => allowed.has(entry))) return { error: "Choose from the list." };
    const unique = [...new Set(list as ReadonlyArray<string>)];
    const least = field.minItems ?? (field.required ? 1 : 0);
    if (unique.length === 0 && least === 0) return field.required ? { value: unique } : {};
    if (unique.length < least)
      return { error: least === 1 ? "Choose at least one." : `Choose at least ${least}.` };
    if (field.maxItems !== undefined && unique.length > field.maxItems)
      return { error: `Choose at most ${field.maxItems}.` };
    return { value: unique };
  }
  if (empty) return field.required ? { error: "Required." } : {};
  if (field.kind === "number") {
    const number =
      typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
    if (!Number.isFinite(number)) return { error: "Enter a number." };
    if (field.integer && !Number.isInteger(number)) return { error: "Enter a whole number." };
    if (field.minimum !== undefined && number < field.minimum)
      return { error: `Enter ${field.minimum} or more.` };
    if (field.maximum !== undefined && number > field.maximum)
      return { error: `Enter ${field.maximum} or less.` };
    return { value: number };
  }
  if (typeof raw !== "string") return { error: "Enter text." };
  if (field.kind === "select")
    return field.options.some((option) => option.value === raw)
      ? { value: raw }
      : { error: "Choose from the list." };
  if (field.minLength !== undefined && raw.length < field.minLength)
    return { error: `Enter at least ${field.minLength} characters.` };
  if (field.maxLength !== undefined && raw.length > field.maxLength)
    return { error: `Enter at most ${field.maxLength} characters.` };
  const error = field.format === undefined ? undefined : formatError(field.format, raw.trim());
  return error === undefined ? { value: raw } : { error };
}

/**
 * Checks filled-in values against the form and returns the content to send:
 * numbers as numbers, empty optional fields left out, keys the form does not
 * name dropped.
 */
export function validateMcpElicitationContent(
  fields: ReadonlyArray<McpElicitationField>,
  values: Readonly<Record<string, unknown>>,
): McpElicitationValidation {
  const content: Record<string, McpElicitationValue> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const checked = checkField(field, values[field.key]);
    if (checked.error !== undefined) errors[field.key] = checked.error;
    else if (checked.value !== undefined) content[field.key] = checked.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, content };
}

// Words that name a credential in a field's key or title. MCP forbids a server
// from asking for secrets in form mode; a form that does is never shown.
const SECRET_FIELD =
  /pass(word|wd|code|phrase)|secret|token|api[\s_-]?key|private[\s_-]?key|access[\s_-]?key|credential|\bpin\b|\botp\b|one[\s_-]?time[\s_-]?(code|password)|2fa|mfa|cvv|cvc|card[\s_-]?number|ssn|social[\s_-]?security/i;

/** The first field that asks for a password, token or other secret, if any. */
export function findMcpElicitationSecretField(
  fields: ReadonlyArray<McpElicitationField>,
): McpElicitationField | undefined {
  return fields.find((field) => SECRET_FIELD.test(field.key) || SECRET_FIELD.test(field.title));
}
