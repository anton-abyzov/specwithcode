/**
 * The Form artifact: a `.form.json` file that is data only. It lists a form's
 * questions in the order they are asked; answers are never kept in it but in
 * the form's responses Sheet (see `responses.ts`). Item types mirror Google
 * Forms' items, so a form maps onto one item by item.
 */
import { OFFICE_ARTIFACTS_DIR, sheetContentRevision, sheetSlug } from "../officeSheet/model.ts";

export const FORM_ARTIFACT_VERSION = 1;
export const FORM_ARTIFACT_KIND = "form";
export const FORM_SUFFIX = ".form.json";
export const FORM_DIR = OFFICE_ARTIFACTS_DIR;
export const FORM_RESPONSES_SUFFIX = "-responses.sheet.json";

export const FORM_LIMITS = {
  bytes: 1024 * 1024,
  /** Questions, sections and text blocks together. */
  items: 300,
  /** Options of one choice question. */
  options: 200,
  titleChars: 500,
  descriptionChars: 5_000,
  optionChars: 500,
  /** Characters in one answer, as a sheet cell holds at most. */
  answerChars: 5_000,
  idChars: 40,
} as const;

/** Questions: each one becomes a column of the responses Sheet. */
export const FORM_QUESTION_TYPES = [
  "short",
  "paragraph",
  "choice",
  "checkboxes",
  "dropdown",
  "scale",
  "date",
  "time",
] as const;
export type FormQuestionType = (typeof FORM_QUESTION_TYPES)[number];

/** Layout items: a section starts a new page, a text block shows a title and text. */
export const FORM_LAYOUT_TYPES = ["section", "text"] as const;
export type FormLayoutType = (typeof FORM_LAYOUT_TYPES)[number];

export type FormItemType = FormQuestionType | FormLayoutType;

export const FORM_ITEM_TYPE_LABELS: Record<FormItemType, string> = {
  short: "Short answer",
  paragraph: "Paragraph",
  choice: "Multiple choice",
  checkboxes: "Checkboxes",
  dropdown: "Dropdown",
  scale: "Linear scale",
  date: "Date",
  time: "Time",
  section: "Section",
  text: "Title and text",
};

/** The scale bounds Google Forms takes: low 0 or 1, high 2 to 10. */
export const FORM_SCALE = { lows: [0, 1], highMin: 2, highMax: 10 } as const;

export interface FormScale {
  readonly min: 0 | 1;
  readonly max: number;
  readonly minLabel?: string;
  readonly maxLabel?: string;
}

export interface FormItem {
  /** Stable, unique in the form; answers are keyed by it. */
  readonly id: string;
  readonly type: FormItemType;
  readonly title: string;
  readonly description?: string;
  /** Questions only. */
  readonly required?: boolean;
  /** Choice, checkboxes and dropdown. */
  readonly options?: ReadonlyArray<string>;
  /** Choice and checkboxes: an "Other" option with a text field. */
  readonly other?: boolean;
  /** Scale only. */
  readonly scale?: FormScale;
}

export interface FormResponsesLink {
  /** The responses Sheet's file name, in the form's own folder. */
  readonly sheet: string;
}

export interface FormDocument {
  readonly v: typeof FORM_ARTIFACT_VERSION;
  readonly kind: typeof FORM_ARTIFACT_KIND;
  readonly title: string;
  readonly description?: string;
  readonly items: ReadonlyArray<FormItem>;
  readonly responses?: FormResponsesLink;
  /** Shown after a response is sent. */
  readonly confirmation?: string;
}

export type FormValidation =
  | { readonly ok: true; readonly document: FormDocument }
  | { readonly ok: false; readonly error: string };

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const RESPONSES_SHEET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.sheet\.json$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isFormQuestion(item: Pick<FormItem, "type">): boolean {
  return (FORM_QUESTION_TYPES as ReadonlyArray<string>).includes(item.type);
}

export function hasOptions(type: FormItemType): boolean {
  return type === "choice" || type === "checkboxes" || type === "dropdown";
}

/** True for a path the form view opens. */
export function isFormPath(path: string): boolean {
  return path.toLowerCase().endsWith(FORM_SUFFIX);
}

/** A file name stem from a title, as sheets make theirs. */
export function formSlug(title: string): string {
  const slug = sheetSlug(title);
  return slug === "sheet" ? "form" : slug;
}

/** The revision token sheets and whiteboards use, so one compare-and-set path serves all three. */
export function formRevision(raw: string): string {
  return sheetContentRevision(raw);
}

/** The responses Sheet's file name for a form file name, used when the form names none. */
export function defaultResponsesSheetName(formFileName: string): string {
  const base = formFileName.replace(/\\/g, "/").split("/").pop() ?? formFileName;
  const stem = isFormPath(base) ? base.slice(0, -FORM_SUFFIX.length) : base;
  return `${stem || "form"}${FORM_RESPONSES_SUFFIX}`;
}

/** The project-relative path of a form's responses Sheet, next to the form. */
export function responsesSheetPath(formRelativePath: string, document: FormDocument): string {
  const normalized = formRelativePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const folder = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  return `${folder}${document.responses?.sheet ?? defaultResponsesSheetName(normalized)}`;
}

function fail(error: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error };
}

/** The text, undefined when optional and absent, null when it is not text within the limit. */
function textField(value: unknown, limit: number, optional: boolean): string | null | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length > limit) return null;
  return value;
}

/** Validates a parsed form. Fields it does not know are left in place, so a save keeps them. */
export function validateFormDocument(value: unknown): FormValidation {
  if (!isRecord(value)) return fail("This file is not a form.");
  if (value.kind !== FORM_ARTIFACT_KIND) return fail('A form file has "kind": "form".');
  if (value.v !== FORM_ARTIFACT_VERSION) {
    return fail(
      `This form is version ${String(value.v)}; this app reads version ${FORM_ARTIFACT_VERSION}.`,
    );
  }
  if (textField(value.title, FORM_LIMITS.titleChars, false) == null) {
    return fail(`The form's title must be text of at most ${FORM_LIMITS.titleChars} characters.`);
  }
  if (textField(value.description, FORM_LIMITS.descriptionChars, true) === null) {
    return fail(
      `The form's description must be text of at most ${FORM_LIMITS.descriptionChars.toLocaleString("en-US")} characters.`,
    );
  }
  if (textField(value.confirmation, FORM_LIMITS.descriptionChars, true) === null) {
    return fail("The confirmation message must be text.");
  }
  if (value.responses !== undefined) {
    if (!isRecord(value.responses) || typeof value.responses.sheet !== "string") {
      return fail('"responses" names the responses Sheet as { "sheet": "<name>.sheet.json" }.');
    }
    if (!RESPONSES_SHEET_PATTERN.test(value.responses.sheet)) {
      return fail(
        "The responses Sheet is a file name in the form's folder, ending in .sheet.json.",
      );
    }
  }
  if (!Array.isArray(value.items)) return fail("The form's items are not a list.");
  if (value.items.length > FORM_LIMITS.items) {
    return fail(`A form holds at most ${FORM_LIMITS.items} items.`);
  }
  const ids = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    const at = `Item ${index + 1}`;
    if (!isRecord(item)) return fail(`${at} is not an object.`);
    if (
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      item.id.length > FORM_LIMITS.idChars ||
      !ID_PATTERN.test(item.id)
    ) {
      return fail(
        `${at} needs an id of letters, digits, "-" or "_" (at most ${FORM_LIMITS.idChars}).`,
      );
    }
    if (ids.has(item.id)) return fail(`${at} repeats the id "${item.id}".`);
    ids.add(item.id);
    const type = item.type;
    if (
      typeof type !== "string" ||
      (!(FORM_QUESTION_TYPES as ReadonlyArray<string>).includes(type) &&
        !(FORM_LAYOUT_TYPES as ReadonlyArray<string>).includes(type))
    ) {
      return fail(
        `${at} has the type ${JSON.stringify(type)}; a form takes ${[...FORM_QUESTION_TYPES, ...FORM_LAYOUT_TYPES].join(", ")}.`,
      );
    }
    if (textField(item.title, FORM_LIMITS.titleChars, false) == null) {
      return fail(`${at}'s title must be text of at most ${FORM_LIMITS.titleChars} characters.`);
    }
    if (textField(item.description, FORM_LIMITS.descriptionChars, true) === null) {
      return fail(
        `${at}'s description must be text of at most ${FORM_LIMITS.descriptionChars.toLocaleString("en-US")} characters.`,
      );
    }
    if (item.required !== undefined && typeof item.required !== "boolean") {
      return fail(`${at}'s "required" is true or false.`);
    }
    if (item.other !== undefined && typeof item.other !== "boolean") {
      return fail(`${at}'s "other" is true or false.`);
    }
    if (item.other === true && type !== "choice" && type !== "checkboxes") {
      return fail(`${at}: only multiple choice and checkboxes take an "Other" option.`);
    }
    const itemType = type as FormItemType;
    if (hasOptions(itemType)) {
      if (!Array.isArray(item.options) || item.options.length === 0) {
        return fail(`${at} needs a list of options.`);
      }
      if (item.options.length > FORM_LIMITS.options) {
        return fail(`${at} has more than ${FORM_LIMITS.options} options.`);
      }
      const seen = new Set<string>();
      for (const option of item.options) {
        if (
          typeof option !== "string" ||
          option.trim().length === 0 ||
          option.length > FORM_LIMITS.optionChars
        ) {
          return fail(
            `${at}'s options are non-empty text of at most ${FORM_LIMITS.optionChars} characters.`,
          );
        }
        if (seen.has(option)) return fail(`${at} lists the option "${option}" twice.`);
        seen.add(option);
      }
    } else if (item.options !== undefined) {
      return fail(`${at}: only multiple choice, checkboxes and dropdown take options.`);
    }
    if (itemType === "scale") {
      const scale = item.scale;
      if (!isRecord(scale)) return fail(`${at} needs a scale: { "min": 1, "max": 5 }.`);
      if (!FORM_SCALE.lows.includes(scale.min as 0 | 1))
        return fail(`${at}'s scale starts at 0 or 1.`);
      if (
        typeof scale.max !== "number" ||
        !Number.isInteger(scale.max) ||
        scale.max < FORM_SCALE.highMin ||
        scale.max > FORM_SCALE.highMax
      ) {
        return fail(
          `${at}'s scale ends at a whole number from ${FORM_SCALE.highMin} to ${FORM_SCALE.highMax}.`,
        );
      }
      for (const key of ["minLabel", "maxLabel"] as const) {
        if (textField(scale[key], FORM_LIMITS.optionChars, true) === null) {
          return fail(
            `${at}'s scale labels are text of at most ${FORM_LIMITS.optionChars} characters.`,
          );
        }
      }
    } else if (item.scale !== undefined) {
      return fail(`${at}: only a linear scale takes a scale.`);
    }
  }
  return { ok: true, document: value as unknown as FormDocument };
}

/** Reads a `.form.json` file. An empty file reads as an empty form. */
export function parseForm(text: string): FormValidation {
  if (text.length > FORM_LIMITS.bytes) {
    return fail(`The file is over the ${FORM_LIMITS.bytes / (1024 * 1024)} MB limit.`);
  }
  const trimmed = text.replace(/^﻿+/, "").trim();
  if (trimmed.length === 0) return validateFormDocument(newFormDocument("Untitled form"));
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return fail("This file is not valid JSON.");
  }
  return validateFormDocument(value);
}

export function serializeForm(document: FormDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** A short random id for a new item, unique among `taken`. */
export function newItemId(
  taken: Iterable<string> = [],
  random: () => number = Math.random,
): string {
  const used = new Set(taken);
  for (;;) {
    const id = `q${random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (!used.has(id)) return id;
  }
}

/** A new item of a type, as the editor adds it. */
export function newFormItem(type: FormItemType, taken: Iterable<string> = []): FormItem {
  const id = newItemId(taken);
  if (type === "section") return { id, type, title: "Untitled section" };
  if (type === "text") return { id, type, title: "Untitled title" };
  const base = { id, type, title: "Untitled question" } as const;
  if (hasOptions(type)) return { ...base, options: ["Option 1"] };
  if (type === "scale") return { ...base, scale: { min: 1, max: 5 } };
  return base;
}

/** A new form with one short-answer question, as the New menu makes it. */
export function newFormDocument(title: string, responsesSheet?: string): FormDocument {
  return {
    v: FORM_ARTIFACT_VERSION,
    kind: FORM_ARTIFACT_KIND,
    title,
    description: "",
    items: [{ id: "q1", type: "short", title: "Untitled question" }],
    ...(responsesSheet !== undefined ? { responses: { sheet: responsesSheet } } : {}),
  };
}

/** The questions of a form, in order. */
export function formQuestions(document: FormDocument): ReadonlyArray<FormItem> {
  return document.items.filter(isFormQuestion);
}

/**
 * Each question's column header in the responses Sheet: its title, or
 * "Untitled question" when it has none; a title used again gets " (2)",
 * " (3)" in question order, so two questions never share a column.
 */
export function questionHeaders(
  document: FormDocument,
): ReadonlyArray<{ readonly item: FormItem; readonly header: string }> {
  const seen = new Map<string, number>();
  return formQuestions(document).map((item) => {
    const title = item.title.trim().length > 0 ? item.title.trim() : "Untitled question";
    const count = (seen.get(title) ?? 0) + 1;
    seen.set(title, count);
    return { item, header: count === 1 ? title : `${title} (${count})` };
  });
}
