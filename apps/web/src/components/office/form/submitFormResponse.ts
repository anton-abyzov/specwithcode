/**
 * Adding one response to a form's responses Sheet from a window: read the
 * Sheet, append the row, write it back by revision, and start over when
 * someone else wrote it in between. A missing Sheet is made header-only
 * first, so the row itself is always written against a revision.
 */
import {
  type FormAnswers,
  type FormDocument,
  appendFormResponse,
  emptyResponsesSheet,
  validateFormAnswers,
} from "@specweave-studio/shared/officeForm";
import {
  parseSheetDocument,
  serializeSheetDocument,
  sheetContentRevision,
} from "@specweave-studio/shared/officeSheet";

import type { FormSubmitOutcome } from "./FormFill";

export const FORM_SUBMIT_ATTEMPTS = 5;

export type SheetRead =
  | { readonly _tag: "contents"; readonly contents: string }
  | { readonly _tag: "gone" }
  | { readonly _tag: "unavailable" };

/** True when written, "conflict" when the Sheet changed since it was read, else why it failed. */
export type SheetWrite = true | "conflict" | { readonly error: string };

export async function submitFormResponse(input: {
  readonly document: FormDocument;
  readonly answers: FormAnswers;
  readonly submittedAt: string;
  readonly read: () => Promise<SheetRead>;
  /** Writes the Sheet; with no revision only when it is missing. */
  readonly write: (contents: string, expectedRevision: string | undefined) => Promise<SheetWrite>;
}): Promise<FormSubmitOutcome> {
  // Answers that do not fit are refused before anything is written, a missing Sheet included.
  const problem = validateFormAnswers(input.document, input.answers)[0];
  if (problem !== undefined) return { ok: false, error: problem.message };
  let created = false;
  for (let attempt = 0; attempt < FORM_SUBMIT_ATTEMPTS; attempt += 1) {
    const read = await input.read();
    if (read._tag === "unavailable") {
      return { ok: false, error: "The responses Sheet could not be read. Try again." };
    }
    if (read._tag === "gone") {
      if (created) return { ok: false, error: "The responses Sheet could not be made. Try again." };
      created = true;
      const made = await input.write(
        serializeSheetDocument(emptyResponsesSheet(input.document)),
        undefined,
      );
      if (made !== true && made !== "conflict") return { ok: false, error: made.error };
      continue;
    }
    const sheet = parseSheetDocument(read.contents);
    if (!sheet.ok) {
      return { ok: false, error: `The responses Sheet cannot take answers: ${sheet.error}` };
    }
    const appended = appendFormResponse(
      sheet.document,
      input.document,
      input.answers,
      input.submittedAt,
    );
    if (!appended.ok) return { ok: false, error: appended.error };
    const written = await input.write(
      serializeSheetDocument(appended.sheet),
      sheetContentRevision(read.contents),
    );
    if (written === true) return { ok: true };
    if (written !== "conflict") return { ok: false, error: written.error };
  }
  return { ok: false, error: "The responses Sheet kept changing while saving. Try again." };
}
