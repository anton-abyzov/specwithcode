import { parseForm, responsesSheetPath } from "@specweave-studio/shared/officeForm";
import { parseSheetDocument } from "@specweave-studio/shared/officeSheet";
import { describe, expect, it } from "vite-plus/test";

import { artifactKindOfFile, ARTIFACT_KIND_LABELS } from "../../../studio/projectArtifacts";
import { ARTIFACT_KIND_LABEL } from "../../../artifactShelf";
import { newFormFiles, newFormStem } from "./newForm";

describe("a new form", () => {
  it("is named by the second it was made, with a random tail", () => {
    expect(newFormStem(new Date(2026, 10, 28, 9, 5, 7), "abc123")).toBe(
      "form-20261128-090507-abc123",
    );
  });

  it("is a valid form and a header-only responses Sheet beside it, linked by name", () => {
    const files = newFormFiles("form-20261128-090507-abc123");
    expect(files.form.relativePath).toBe(
      ".specweave/artifacts/form-20261128-090507-abc123.form.json",
    );
    expect(files.sheet.relativePath).toBe(
      ".specweave/artifacts/form-20261128-090507-abc123-responses.sheet.json",
    );
    const form = parseForm(files.form.contents);
    if (!form.ok) throw new Error(form.error);
    expect(responsesSheetPath(files.form.relativePath, form.document)).toBe(
      files.sheet.relativePath,
    );
    const sheet = parseSheetDocument(files.sheet.contents);
    expect(sheet.ok && sheet.document.tabs[0]!.cells).toEqual({
      A1: "Submitted at",
      B1: "Untitled question",
    });
  });

  it("lists as a Form artifact", () => {
    expect(artifactKindOfFile(".specweave/artifacts/a.form.json")).toBe("form");
    expect(ARTIFACT_KIND_LABELS.form).toBe("Form");
    expect(ARTIFACT_KIND_LABEL.form).toBe("Form");
    // Its responses Sheet stays a Sheet.
    expect(artifactKindOfFile(".specweave/artifacts/a-responses.sheet.json")).toBe("sheet");
  });
});
