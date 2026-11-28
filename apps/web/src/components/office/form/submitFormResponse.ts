/**
 * Adding one response to a form's responses Sheet from a window: read the
 * Sheet, append the row, write it back by revision, and start over when
 * someone else wrote it in between. A missing Sheet is made header-only
 * first, only if still missing, so the row itself is always written against a
 * revision and a Sheet made meanwhile is never replaced.
 */
import {
  type FormAnswers,
  type FormDocument,
  appendFormResponse,
  emptyResponsesSheet,
  validateFormAnswers,
} from "@specweave-studio/shared/officeForm";
import {
  NEW_FILE_REVISION,
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
  /** Writes the Sheet by revision; `NEW_FILE_REVISION` creates it only if missing. */
  readonly write: (contents: string, expectedRevision: string | undefined) => Promise<SheetWrite>;
}): Promise<FormSubmitOutcome> {
  // Answers that do not fit are refused before anything is written, a missing Sheet included.
  const problem = validateFormAnswers(input.document, input.answers)[0];
  if (problem !== undefined) return { ok: false, error: problem.message };
  let creates = 0;
  for (let attempt = 0; attempt < FORM_SUBMIT_ATTEMPTS; attempt += 1) {
    const read = await input.read();
    if (read._tag === "unavailable") {
      return { ok: false, error: "The responses Sheet could not be read. Try again." };
    }
    if (read._tag === "gone") {
      // Made only if still missing, so a Sheet another window made meanwhile, with its
      // answers, is never replaced; that conflict just means the next read finds it.
      // Never a plain write: it could replace answers that landed in between.
      if (creates >= 2) {
        return {
          ok: false,
          error:
            "The responses Sheet could not be made. Update SpecWithCode on the machine that holds this project, then try again.",
        };
      }
      creates += 1;
      const made = await input.write(
        serializeSheetDocument(emptyResponsesSheet(input.document)),
        NEW_FILE_REVISION,
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
