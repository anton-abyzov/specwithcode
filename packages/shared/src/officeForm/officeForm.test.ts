import { describe, expect, it } from "vite-plus/test";

import { parseSheetDocument, serializeSheetDocument } from "../officeSheet/model.ts";
import {
  FORM_LIMITS,
  type FormDocument,
  defaultResponsesSheetName,
  isFormPath,
  newFormDocument,
  newFormItem,
  parseForm,
  questionHeaders,
  responsesSheetPath,
  serializeForm,
} from "./model.ts";
import {
  answerTextInput,
  appendFormResponse,
  emptyResponsesSheet,
  formResponseCount,
  validateFormAnswers,
} from "./responses.ts";

const form: FormDocument = {
  v: 1,
  kind: "form",
  title: "Team offsite",
  description: "Tell us what works for you.",
  items: [
    { id: "name", type: "short", title: "Your name", required: true },
    { id: "notes", type: "paragraph", title: "Anything else?" },
    { id: "city", type: "choice", title: "City", options: ["Lisbon", "Berlin"], other: true },
    { id: "food", type: "checkboxes", title: "Food", options: ["Vegan", "Fish", "Meat"] },
    { id: "size", type: "dropdown", title: "Shirt size", options: ["S", "M", "L"] },
    { id: "page2", type: "section", title: "Dates" },
    {
      id: "mood",
      type: "scale",
      title: "How excited?",
      scale: { min: 1, max: 5, minLabel: "Meh", maxLabel: "Very" },
    },
    { id: "day", type: "date", title: "Arrival" },
    { id: "at", type: "time", title: "Arrival time" },
    { id: "intro", type: "text", title: "Thanks", description: "That is all." },
  ],
};

const text = serializeForm(form);

describe("form files", () => {
  it("round-trips a valid form unchanged and keeps fields the app does not know", () => {
    const parsed = parseForm(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeForm(parsed.document)).toBe(text);
    const withExtra = JSON.stringify({
      ...form,
      google: { formId: "abc" },
      items: [{ ...form.items[0], color: "red" }],
    });
    const extra = parseForm(withExtra);
    expect(extra.ok).toBe(true);
    if (!extra.ok) return;
    expect(JSON.parse(serializeForm(extra.document))).toMatchObject({
      google: { formId: "abc" },
      items: [{ color: "red" }],
    });
  });

  it("reads an empty file as a new form", () => {
    const parsed = parseForm("");
    expect(parsed.ok && parsed.document.items.length).toBe(1);
  });

  it.each([
    [{ ...form, kind: "sheet" }, 'A form file has "kind": "form".'],
    [{ ...form, v: 2 }, "version 2"],
    [{ ...form, items: [{ type: "short", title: "x" }] }, "needs an id"],
    [{ ...form, items: [form.items[0], form.items[0]] }, 'repeats the id "name"'],
    [{ ...form, items: [{ id: "a", type: "upload", title: "x" }] }, 'the type "upload"'],
    [{ ...form, items: [{ id: "a", type: "choice", title: "x" }] }, "needs a list of options"],
    [
      { ...form, items: [{ id: "a", type: "choice", title: "x", options: ["A", "A"] }] },
      'option "A" twice',
    ],
    [
      { ...form, items: [{ id: "a", type: "dropdown", title: "x", options: ["A"], other: true }] },
      '"Other" option',
    ],
    [
      { ...form, items: [{ id: "a", type: "scale", title: "x", scale: { min: 2, max: 5 } }] },
      "starts at 0 or 1",
    ],
    [
      { ...form, items: [{ id: "a", type: "scale", title: "x", scale: { min: 1, max: 11 } }] },
      "from 2 to 10",
    ],
    [
      { ...form, items: [{ id: "a", type: "short", title: "x", options: ["A"] }] },
      "only multiple choice",
    ],
    [{ ...form, title: "t".repeat(FORM_LIMITS.titleChars + 1) }, "at most 500 characters"],
    [
      {
        ...form,
        items: Array.from({ length: FORM_LIMITS.items + 1 }, (_, i) => ({
          id: `q${i}`,
          type: "short",
          title: "x",
        })),
      },
      "at most 300 items",
    ],
    [{ ...form, responses: { sheet: "../escape.sheet.json" } }, "file name in the form's folder"],
  ])("refuses a broken form with a message naming the problem (%#)", (value, message) => {
    const parsed = parseForm(JSON.stringify(value));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("refuses text that is not JSON", () => {
    expect(parseForm("{")).toEqual({ ok: false, error: "This file is not valid JSON." });
  });

  it("names paths and the responses Sheet next to the form, also with backslashes", () => {
    expect(isFormPath(".specweave/artifacts/a.FORM.json")).toBe(true);
    expect(isFormPath("a.sheet.json")).toBe(false);
    expect(defaultResponsesSheetName("form-1.form.json")).toBe("form-1-responses.sheet.json");
    expect(responsesSheetPath(".specweave\\artifacts\\team\\offsite.form.json", form)).toBe(
      ".specweave/artifacts/team/offsite-responses.sheet.json",
    );
    expect(
      responsesSheetPath(".specweave/artifacts/x.form.json", {
        ...form,
        responses: { sheet: "answers.sheet.json" },
      }),
    ).toBe(".specweave/artifacts/answers.sheet.json");
  });

  it("makes new items of every type that validate", () => {
    const items = (
      [
        "short",
        "paragraph",
        "choice",
        "checkboxes",
        "dropdown",
        "scale",
        "date",
        "time",
        "section",
        "text",
      ] as const
    ).map((type) => newFormItem(type));
    const parsed = parseForm(JSON.stringify({ ...newFormDocument("New"), items }));
    expect(parsed.ok).toBe(true);
  });

  it("gives questions with the same title their own headers", () => {
    const doc: FormDocument = {
      ...form,
      items: [
        { id: "a", type: "short", title: "Name" },
        { id: "b", type: "short", title: "Name" },
        { id: "c", type: "short", title: "" },
      ],
    };
    expect(questionHeaders(doc).map((each) => each.header)).toEqual([
      "Name",
      "Name (2)",
      "Untitled question",
    ]);
  });
});

describe("answers", () => {
  const good = {
    name: "Ana",
    notes: "Line one\nLine two",
    city: "Porto",
    food: ["Meat", "Vegan"],
    size: "M",
    mood: 4,
    day: "2026-12-01",
    at: "09:30",
  };

  it("accepts answers that fit the form", () => {
    expect(validateFormAnswers(form, good)).toEqual([]);
  });

  it("names each question whose answer is refused", () => {
    const problems = validateFormAnswers(form, {
      name: "  ",
      city: "",
      food: ["Cake"],
      size: "XL",
      mood: 6,
      day: "2026-02-30",
      at: "25:00",
    });
    expect(problems.map((each) => each.itemId)).toEqual([
      "name",
      "food",
      "size",
      "mood",
      "day",
      "at",
    ]);
    expect(problems[0]!.message).toBe("This question is required.");
    expect(validateFormAnswers(form, { name: "a\nb" })[0]!.message).toBe(
      "A short answer is one line.",
    );
  });

  it("appends a row per response with the time first and columns by question", () => {
    const first = appendFormResponse(null, form, good, "2026-11-28 10:00:00");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cells = first.sheet.tabs[0]!.cells;
    expect(first.sheet.tabs[0]!.name).toBe("Responses");
    expect(cells.A1).toBe("Submitted at");
    expect([
      cells.B1,
      cells.C1,
      cells.D1,
      cells.E1,
      cells.F1,
      cells.G1,
      cells.H1,
      cells.I1,
    ]).toEqual([
      "Your name",
      "Anything else?",
      "City",
      "Food",
      "Shirt size",
      "How excited?",
      "Arrival",
      "Arrival time",
    ]);
    expect(first.row).toBe(2);
    expect(cells.A2).toBe("2026-11-28 10:00:00");
    expect(cells.D2).toBe("Porto");
    // Picks in the order the options are listed.
    expect(cells.E2).toBe("Vegan, Meat");
    expect(cells.G2).toBe(4);
    const second = appendFormResponse(first.sheet, form, { name: "Bo" }, "2026-11-28 10:05:00");
    expect(second.ok && second.row).toBe(3);
    if (!second.ok) return;
    expect(second.sheet.tabs[0]!.cells.B3).toBe("Bo");
    expect(second.sheet.tabs[0]!.cells.C3).toBeUndefined();
    expect(formResponseCount(second.sheet)).toBe(2);
    // The result is a sheet the Sheet editor reads.
    expect(parseSheetDocument(serializeSheetDocument(second.sheet)).ok).toBe(true);
  });

  it("keeps an answer that reads as a formula as text", () => {
    expect(answerTextInput('=HYPERLINK("http://x")')).toBe('\'=HYPERLINK("http://x")');
    expect(answerTextInput("'=1")).toBe("''=1");
    expect(answerTextInput("50%")).toBe("50%");
    const appended = appendFormResponse(null, form, { ...good, name: "=1+1" }, "t");
    expect(appended.ok && appended.sheet.tabs[0]!.cells.B2).toBe("'=1+1");
  });

  it("adds a column at the end for a new question and keeps the old ones", () => {
    const first = appendFormResponse(null, form, good, "t1");
    if (!first.ok) throw new Error(first.error);
    const changed: FormDocument = {
      ...form,
      items: [{ id: "role", type: "short", title: "Role" }, ...form.items],
    };
    const second = appendFormResponse(first.sheet, changed, { ...good, role: "Dev" }, "t2");
    if (!second.ok) throw new Error(second.error);
    const cells = second.sheet.tabs[0]!.cells;
    expect(cells.J1).toBe("Role");
    expect(cells.J3).toBe("Dev");
    expect(cells.B3).toBe("Ana");
    expect(Object.keys(second.sheet.tabs[0]!.styles ?? {})).toEqual(["A1:J1"]);
  });

  it("starts an empty responses Sheet with only its header row", () => {
    const sheet = emptyResponsesSheet(form);
    expect(sheet.title).toBe("Team offsite (responses)");
    expect(formResponseCount(sheet)).toBe(0);
    expect(Object.keys(sheet.tabs[0]!.cells)).toHaveLength(9);
  });

  it("refuses answers that do not fit before anything is appended", () => {
    expect(appendFormResponse(null, form, { name: "" }, "t")).toEqual({
      ok: false,
      error: "This question is required.",
    });
  });
});

describe("review round 1: columns, tabs and long answers", () => {
  const titled = (titles: string[]): FormDocument => ({
    v: 1,
    kind: "form",
    title: "T",
    items: titles.map((title, index) => ({ id: `q${index}`, type: "short", title })),
  });

  it("never gives two questions, or a question and the time, one header", () => {
    expect(
      questionHeaders(titled(["Name", "Name", "Name (2)", "Submitted at"])).map((e) => e.header),
    ).toEqual(["Name", "Name (2)", "Name (2) (2)", "Submitted at (2)"]);
  });

  it("adds a Responses tab instead of writing into a person's own tab", () => {
    const budget = {
      v: 1,
      kind: "sheet",
      title: "Budget",
      tabs: [{ name: "Costs", cells: { A1: "Item", B1: "Cost" } }],
    } as const;
    const appended = appendFormResponse(budget as never, titled(["Name"]), { q0: "Ana" }, "t");
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.sheet.tabs[0]).toEqual(budget.tabs[0]);
    expect(appended.sheet.tabs[1]!.name).toBe("Responses");
    expect(appended.sheet.tabs[1]!.cells).toMatchObject({
      A1: "Submitted at",
      B1: "Name",
      B2: "Ana",
    });
  });

  it("counts no responses in a Sheet without a Responses tab", () => {
    const sheet = {
      v: 1,
      kind: "sheet",
      title: "B",
      tabs: [{ name: "Costs", cells: { A1: "x", A2: "y" } }],
    };
    expect(formResponseCount(sheet as never)).toBe(0);
  });

  it("puts the time in a new column when A1 holds a person's header", () => {
    const sheet = {
      v: 1,
      kind: "sheet",
      title: "R",
      tabs: [{ name: "Responses", cells: { A1: "Notes" }, styles: { "A1:C1": { italic: true } } }],
    } as const;
    const appended = appendFormResponse(sheet as never, titled(["Name"]), { q0: "Ana" }, "t");
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const tab = appended.sheet.tabs[0]!;
    expect(tab.cells).toMatchObject({
      A1: "Notes",
      B1: "Submitted at",
      C1: "Name",
      B2: "t",
      C2: "Ana",
    });
    expect(tab.cells.A2).toBeUndefined();
    // A person's own style on row 1 stays.
    expect(tab.styles?.["A1:C1"]).toEqual({ italic: true, bold: true, fill: true });
  });

  it("keeps a 5,000-character answer whole and never splits a surrogate pair", () => {
    const long = "x".repeat(5_000);
    expect(answerTextInput(long)).toBe(long);
    const formula = `=${"😀".repeat(2_500)}`;
    const input = answerTextInput(formula);
    expect(input.length).toBeLessThanOrEqual(5_000);
    expect(input.startsWith("'=")).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(input)).toBe(false);
  });
});
