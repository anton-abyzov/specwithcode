/**
 * Answers to a form, checked against its questions and appended as one row of
 * the form's responses Sheet: the submission time first, then one column per
 * question, found by its header in row 1 (see `questionHeaders`). Answers are
 * data from whoever filled the form in, so text never becomes a formula.
 */
import {
  SHEET_ARTIFACT_KIND,
  SHEET_ARTIFACT_VERSION,
  SHEET_LIMITS,
  type SheetCellInput,
  type SheetDocument,
  type SheetTab,
  columnLetters,
  parseCellAddress,
  serializeSheetDocument,
  validateSheetDocument,
} from "../officeSheet/model.ts";
import {
  FORM_LIMITS,
  type FormDocument,
  type FormItem,
  SUBMITTED_AT_HEADER,
  questionHeaders,
} from "./model.ts";

export const RESPONSES_TAB = "Responses";

/** One answer: text, the options picked, or a scale number. Absent or null when left empty. */
export type FormAnswer = string | ReadonlyArray<string> | number | null;
export type FormAnswers = Readonly<Record<string, FormAnswer | undefined>>;

export interface FormAnswerProblem {
  readonly itemId: string;
  readonly message: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isEmpty(answer: FormAnswer | undefined): boolean {
  if (answer === undefined || answer === null) return true;
  if (typeof answer === "string") return answer.trim().length === 0;
  if (typeof answer === "number") return false;
  return answer.length === 0;
}

function validDate(text: string): boolean {
  const match = DATE.exec(text);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

function answerProblem(item: FormItem, answer: FormAnswer | undefined): string | null {
  if (isEmpty(answer)) return item.required === true ? "This question is required." : null;
  const options = item.options ?? [];
  const known = (text: string) =>
    options.includes(text) || (item.other === true && text.trim().length > 0);
  switch (item.type) {
    case "short":
    case "paragraph":
      if (typeof answer !== "string") return "The answer is text.";
      if (answer.length > FORM_LIMITS.answerChars) {
        return `The answer is longer than ${FORM_LIMITS.answerChars.toLocaleString("en-US")} characters.`;
      }
      return item.type === "short" && /[\r\n]/.test(answer) ? "A short answer is one line." : null;
    case "choice":
    case "dropdown":
      if (typeof answer !== "string") return "Pick one option.";
      if (answer.length > FORM_LIMITS.answerChars) return "The answer is too long.";
      return item.type === "dropdown"
        ? options.includes(answer)
          ? null
          : "Pick one of the options."
        : known(answer)
          ? null
          : "Pick one of the options.";
    case "checkboxes": {
      if (!Array.isArray(answer) || answer.some((value) => typeof value !== "string")) {
        return "Pick one or more options.";
      }
      const picked = answer as ReadonlyArray<string>;
      if (new Set(picked).size !== picked.length) return "An option is picked twice.";
      if (picked.join(", ").length > FORM_LIMITS.answerChars) return "The answer is too long.";
      return picked.every(known) ? null : "Pick from the options.";
    }
    case "scale": {
      const scale = item.scale ?? { min: 1, max: 5 };
      return typeof answer === "number" &&
        Number.isInteger(answer) &&
        answer >= scale.min &&
        answer <= scale.max
        ? null
        : `Pick a number from ${scale.min} to ${scale.max}.`;
    }
    case "date":
      return typeof answer === "string" && validDate(answer) ? null : "Enter a date as YYYY-MM-DD.";
    case "time":
      return typeof answer === "string" && TIME.test(answer) ? null : "Enter a time as HH:MM.";
    default:
      return null;
  }
}

/** Every answer the form would refuse, in question order. Empty when the answers may be sent. */
export function validateFormAnswers(
  document: FormDocument,
  answers: FormAnswers,
): FormAnswerProblem[] {
  const problems: FormAnswerProblem[] = [];
  for (const { item } of questionHeaders(document)) {
    const message = answerProblem(item, answers[item.id]);
    if (message !== null) problems.push({ itemId: item.id, message });
  }
  return problems;
}

/**
 * Text from a respondent as a cell input: text that would read as a formula
 * stays text behind one apostrophe, as a pasted cell does.
 */
export function answerTextInput(text: string): string {
  const formula = /^'*=/.test(text);
  // Room for the apostrophe only when one is added; never half of a surrogate pair.
  const room = SHEET_LIMITS.textChars - (formula ? 1 : 0);
  let clipped = text;
  if (clipped.length > room) {
    const cut = /[\uD800-\uDBFF]/.test(clipped.charAt(room - 1)) ? room - 1 : room;
    clipped = clipped.slice(0, cut);
  }
  return formula ? `'${clipped}` : clipped;
}

function answerCell(item: FormItem, answer: FormAnswer | undefined): SheetCellInput | null {
  if (isEmpty(answer)) return null;
  if (typeof answer === "number") return answer;
  if (Array.isArray(answer)) {
    // Kept in the order the options are listed, "Other" text last, as Google Forms writes them.
    const options = item.options ?? [];
    const picked = answer as ReadonlyArray<string>;
    const ordered = [
      ...options.filter((option) => picked.includes(option)),
      ...picked.filter((value) => !options.includes(value)),
    ];
    return answerTextInput(ordered.join(", "));
  }
  return answerTextInput(String(answer));
}

/** A submission time as the responses Sheet shows it, in the machine's local time. */
export function formatSubmittedAt(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function lastRow(tab: SheetTab): number {
  let last = 0;
  for (const key of Object.keys(tab.cells)) {
    const address = parseCellAddress(key);
    if (address !== null && address.row + 1 > last) last = address.row + 1;
  }
  return last;
}

/** The tab named "Responses", or -1: answers never go into another tab a person made. */
function responsesTabIndex(sheet: SheetDocument): number {
  return sheet.tabs.findIndex((tab) => tab.name === RESPONSES_TAB);
}

/** The header style this module writes; a person's own style on row 1 is kept. */
const HEADER_STYLE = { bold: true, fill: true } as const;

function isFormHeaderStyle(range: string, style: unknown): boolean {
  if (!/^A1:[A-Z]+1$/.test(range) || typeof style !== "object" || style === null) return false;
  const keys = Object.keys(style);
  return (
    keys.length === 2 &&
    (style as Record<string, unknown>).bold === true &&
    (style as Record<string, unknown>).fill === true
  );
}

/** A responses Sheet with only its header row, as made with a new form. */
export function emptyResponsesSheet(document: FormDocument): SheetDocument {
  const appended = withHeaders(
    {
      v: SHEET_ARTIFACT_VERSION,
      kind: SHEET_ARTIFACT_KIND,
      title: responsesSheetTitle(document),
      tabs: [{ name: RESPONSES_TAB, cells: {} }],
    },
    document,
  );
  return appended.sheet;
}

export function responsesSheetTitle(document: FormDocument): string {
  const title = document.title.trim().length > 0 ? document.title.trim() : "Untitled form";
  return `${title} (responses)`.slice(0, SHEET_LIMITS.titleChars);
}

/** The header row with every question's column, adding columns at the end for new questions. */
function withHeaders(
  sheet: SheetDocument,
  document: FormDocument,
): {
  readonly sheet: SheetDocument;
  readonly columns: ReadonlyMap<string, number>;
  readonly submittedAt: number;
} {
  // A Sheet without a "Responses" tab gets one at the end, its own tabs untouched.
  const found = responsesTabIndex(sheet);
  const tabIndex = found >= 0 ? found : sheet.tabs.length;
  const tab = sheet.tabs[tabIndex] ?? { name: RESPONSES_TAB, cells: {} };
  const cells: Record<string, SheetCellInput> = { ...tab.cells };
  const byHeader = new Map<string, number>();
  let width = 0;
  for (const [key, value] of Object.entries(cells)) {
    const address = parseCellAddress(key);
    if (address === null || address.row !== 0) continue;
    width = Math.max(width, address.col + 1);
    if (typeof value !== "string") continue;
    // A header kept as text behind an apostrophe reads as the title it stands for.
    const header = /^'+=/.test(value) ? value.slice(1) : value;
    if (!byHeader.has(header)) byHeader.set(header, address.col);
  }
  if (!byHeader.has(SUBMITTED_AT_HEADER)) {
    // Column A when it is free, else a new column: the time never lands under a person's header.
    const col = cells.A1 === undefined ? 0 : width;
    cells[`${columnLetters(col)}1`] = SUBMITTED_AT_HEADER;
    byHeader.set(SUBMITTED_AT_HEADER, col);
    width = Math.max(width, col + 1);
  }
  const columns = new Map<string, number>();
  for (const { item, header } of questionHeaders(document)) {
    let col = byHeader.get(header);
    if (col === undefined) {
      col = width;
      width += 1;
      cells[`${columnLetters(col)}1`] = answerTextInput(header);
      byHeader.set(header, col);
    }
    columns.set(item.id, col);
  }
  const last = columnLetters(Math.max(width, 1) - 1);
  // One header style, widened as columns are added, never a pile of older ones.
  const kept = Object.entries(tab.styles ?? {}).filter(
    ([range, style]) => !isFormHeaderStyle(range, style),
  );
  const header = `A1:${last}1`;
  const own = Object.fromEntries(kept);
  // A person's own style on exactly that range keeps its other settings.
  const styles = { ...own, [header]: { ...own[header], ...HEADER_STYLE } };
  const nextTab: SheetTab = { ...tab, cells, styles };
  const tabs =
    tabIndex >= sheet.tabs.length
      ? [...sheet.tabs, nextTab]
      : sheet.tabs.map((each, index) => (index === tabIndex ? nextTab : each));
  return {
    sheet: { ...sheet, tabs },
    columns,
    submittedAt: byHeader.get(SUBMITTED_AT_HEADER) ?? 0,
  };
}

export type FormAppend =
  | { readonly ok: true; readonly sheet: SheetDocument; readonly row: number }
  | { readonly ok: false; readonly error: string };

/**
 * The responses Sheet with one more row: `sheet` as read, or null to start one.
 * Refused when the answers do not fit the form or the Sheet would pass its limits.
 */
export function appendFormResponse(
  sheet: SheetDocument | null,
  document: FormDocument,
  answers: FormAnswers,
  submittedAt: string,
): FormAppend {
  const problems = validateFormAnswers(document, answers);
  if (problems.length > 0) return { ok: false, error: problems[0]!.message };
  const headed = withHeaders(sheet ?? emptyResponsesSheet(document), document);
  const tabIndex = responsesTabIndex(headed.sheet);
  const tab = headed.sheet.tabs[tabIndex]!;
  const row = Math.max(lastRow(tab), 1) + 1;
  if (row > SHEET_LIMITS.rows) {
    return { ok: false, error: "The responses Sheet is full. Rename it to start a new one." };
  }
  const cells: Record<string, SheetCellInput> = {
    ...tab.cells,
    [`${columnLetters(headed.submittedAt)}${row}`]: submittedAt,
  };
  for (const { item } of questionHeaders(document)) {
    const col = headed.columns.get(item.id);
    if (col === undefined) continue;
    if (col >= SHEET_LIMITS.columns) {
      return { ok: false, error: "The responses Sheet has no room for another column." };
    }
    const value = answerCell(item, answers[item.id]);
    if (value !== null) cells[`${columnLetters(col)}${row}`] = value;
  }
  const next: SheetDocument = {
    ...headed.sheet,
    tabs: headed.sheet.tabs.map((each, index) => (index === tabIndex ? { ...tab, cells } : each)),
  };
  const checked = validateSheetDocument(next);
  if (!checked.ok)
    return { ok: false, error: `The responses Sheet cannot take this response: ${checked.error}` };
  if (
    new TextEncoder().encode(serializeSheetDocument(checked.document)).byteLength >
    SHEET_LIMITS.bytes
  ) {
    return { ok: false, error: "The responses Sheet is full. Rename it to start a new one." };
  }
  return { ok: true, sheet: checked.document, row };
}

/** How many responses a responses Sheet holds: its rows below the header. */
export function formResponseCount(sheet: SheetDocument): number {
  const tab = sheet.tabs[responsesTabIndex(sheet)];
  if (tab === undefined) return 0;
  return Math.max(lastRow(tab) - 1, 0);
}
