// @vitest-environment jsdom

import {
  type FormDocument,
  formRevision,
  parseForm,
  serializeForm,
} from "@specweave-studio/shared/officeForm";
import { parseSheetDocument, sheetContentRevision } from "@specweave-studio/shared/officeSheet";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { changeItemType, duplicateItem, moveItem } from "./FormEditor";
import { fillAnswers, formPages } from "./FormFill";
import { FORM_SAVE_DELAY_MS, FormView } from "./FormView";
import { type SheetRead, type SheetWrite, submitFormResponse } from "./submitFormResponse";

const FORM: FormDocument = {
  v: 1,
  kind: "form",
  title: "Offsite",
  items: [
    { id: "name", type: "short", title: "Your name", required: true },
    { id: "city", type: "choice", title: "City", options: ["Lisbon", "Berlin"], other: true },
    { id: "next", type: "section", title: "More" },
    { id: "food", type: "checkboxes", title: "Food", options: ["Vegan", "Fish"] },
  ],
};
const TEXT = serializeForm(FORM);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name || each.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found as HTMLButtonElement;
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

async function render(props: Partial<Parameters<typeof FormView>[0]> = {}) {
  await act(async () =>
    root.render(
      <FormView
        text={TEXT}
        onSave={undefined}
        onSubmit={undefined}
        onReload={() => undefined}
        responseCount={3}
        responses={<p>Sheet here</p>}
        {...props}
      />,
    ),
  );
}

describe("FormView", () => {
  it("edits the form and saves it by the revision it read", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => true as const);
    await render({ onSave });
    const title = container.querySelector('input[aria-label="Form title"]') as HTMLInputElement;
    await act(async () => setValue(title, "Offsite 2026"));
    await act(async () => button("Add question").click());
    await act(async () => {
      vi.advanceTimersByTime(FORM_SAVE_DELAY_MS + 10);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const [contents, revision] = onSave.mock.calls[0] as unknown as [string, string];
    expect(revision).toBe(formRevision(TEXT));
    const saved = parseForm(contents);
    expect(saved.ok && saved.document.title).toBe("Offsite 2026");
    expect(saved.ok && saved.document.items).toHaveLength(5);
    expect(container.textContent).toContain("Saved");
  });

  it("does not save a form the file format would refuse, and says why", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => true as const);
    await render({ onSave });
    const option = container.querySelector('input[aria-label="Option 2"]') as HTMLInputElement;
    await act(async () => setValue(option, "Lisbon"));
    await act(async () => {
      vi.advanceTimersByTime(FORM_SAVE_DELAY_MS + 10);
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain('lists the option "Lisbon" twice');
  });

  it("offers the saved form after a conflict", async () => {
    vi.useFakeTimers();
    const onReload = vi.fn();
    await render({ onSave: async () => "conflict", onReload });
    const title = container.querySelector('input[aria-label="Form title"]') as HTMLInputElement;
    await act(async () => setValue(title, "Mine"));
    await act(async () => {
      vi.advanceTimersByTime(FORM_SAVE_DELAY_MS + 10);
    });
    expect(container.textContent).toContain("This form changed on disk.");
    await act(async () => button("Load the saved form").click());
    expect(onReload).toHaveBeenCalled();
    expect(title.value).toBe("Offsite");
  });

  it("opens read-only to Fill in where files cannot be changed, and shows the response count", async () => {
    await render();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Fill in",
    );
    expect(container.textContent).not.toContain("Edit");
    expect(container.textContent).toContain("Responses (3)");
    await act(async () => button("Responses (3)").click());
    expect(container.textContent).toContain("Sheet here");
  });

  it("refuses a page with a required question left empty, then sends the answers", async () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const }));
    await render({ onSubmit, initialTab: "fill" });
    await act(async () => button("Next").click());
    expect(container.textContent).toContain("This question is required.");
    const name = container.querySelector(
      'input[aria-labelledby="form-q-name"]',
    ) as HTMLInputElement;
    await act(async () => setValue(name, "Ana"));
    // The name's error goes once it is answered; the city was never required.
    expect(container.textContent).not.toContain("This question is required.");
    const other = [...container.querySelectorAll('input[type="radio"]')][2] as HTMLInputElement;
    await act(async () => other.click());
    await act(async () =>
      setValue(
        container.querySelector('input[aria-label="Other answer"]') as HTMLInputElement,
        "Porto",
      ),
    );
    await act(async () => button("Next").click());
    expect(container.textContent).toContain("Page 2 of 2");
    const vegan = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => vegan.click());
    await act(async () => button("Submit").click());
    expect(onSubmit).toHaveBeenCalledWith(FORM, { name: "Ana", city: "Porto", food: ["Vegan"] });
    expect(container.textContent).toContain("Your response has been recorded.");
  });
});

describe("form editing helpers", () => {
  it("changes type keeping what fits and dropping what does not", () => {
    const choice = changeItemType({ id: "a", type: "short", title: "T", required: true }, "choice");
    expect(choice).toEqual({
      id: "a",
      type: "choice",
      title: "T",
      required: true,
      options: ["Option 1"],
    });
    const back = changeItemType({ ...choice, other: true, color: "x" } as never, "dropdown");
    expect(back).toEqual({
      id: "a",
      type: "dropdown",
      title: "T",
      required: true,
      options: ["Option 1"],
      color: "x",
    });
    expect(changeItemType(choice, "section")).toEqual({ id: "a", type: "section", title: "T" });
    expect(changeItemType(choice, "scale")).toMatchObject({ scale: { min: 1, max: 5 } });
  });

  it("moves and duplicates items under a new id", () => {
    expect(moveItem(FORM, 0, 1).items.map((item) => item.id)).toEqual([
      "city",
      "name",
      "next",
      "food",
    ]);
    expect(moveItem(FORM, 0, -1)).toBe(FORM);
    const copy = duplicateItem(FORM, 0);
    expect(copy.items).toHaveLength(5);
    expect(copy.items[1]!.title).toBe("Your name");
    expect(copy.items[1]!.id).not.toBe("name");
  });

  it("splits pages at sections and puts Other text in the answers", () => {
    expect(formPages(FORM).map((page) => page.map((item) => item.id))).toEqual([
      ["name", "city"],
      ["next", "food"],
    ]);
    expect(
      fillAnswers(FORM, {
        values: { name: "A", city: "Lisbon", food: ["Fish"] },
        other: { city: { on: true, text: "Rome" } },
      }),
    ).toEqual({ name: "A", city: "Rome", food: ["Fish"] });
  });
});

describe("submitFormResponse", () => {
  function sheetStore(initial: string | null) {
    let contents = initial;
    const writes: Array<{ contents: string; revision: string | undefined }> = [];
    let conflicts = 0;
    return {
      writes,
      get contents() {
        return contents;
      },
      failNext(times: number) {
        conflicts = times;
      },
      read: async (): Promise<SheetRead> =>
        contents === null ? { _tag: "gone" } : { _tag: "contents", contents },
      write: async (next: string, revision: string | undefined): Promise<SheetWrite> => {
        writes.push({ contents: next, revision });
        if (conflicts > 0) {
          conflicts -= 1;
          // Someone else added a row in between.
          return "conflict";
        }
        if (
          revision !== undefined &&
          (contents === null || sheetContentRevision(contents) !== revision)
        ) {
          return "conflict";
        }
        contents = next;
        return true;
      },
    };
  }

  it("makes a missing Sheet header-only, then appends the row by revision", async () => {
    const store = sheetStore(null);
    const outcome = await submitFormResponse({
      document: FORM,
      answers: { name: "Ana" },
      submittedAt: "2026-11-28 10:00:00",
      read: store.read,
      write: store.write,
    });
    expect(outcome).toEqual({ ok: true });
    expect(store.writes.map((each) => each.revision === undefined)).toEqual([true, false]);
    const sheet = parseSheetDocument(store.contents!);
    expect(sheet.ok && sheet.document.tabs[0]!.cells).toMatchObject({
      A2: "2026-11-28 10:00:00",
      B2: "Ana",
    });
  });

  it("retries on a conflict and gives up after five", async () => {
    const store = sheetStore(null);
    await submitFormResponse({
      document: FORM,
      answers: { name: "A" },
      submittedAt: "t1",
      read: store.read,
      write: store.write,
    });
    store.failNext(2);
    expect(
      await submitFormResponse({
        document: FORM,
        answers: { name: "B" },
        submittedAt: "t2",
        read: store.read,
        write: store.write,
      }),
    ).toEqual({ ok: true });
    const sheet = parseSheetDocument(store.contents!);
    expect(sheet.ok && sheet.document.tabs[0]!.cells.B3).toBe("B");
    store.failNext(10);
    expect(
      await submitFormResponse({
        document: FORM,
        answers: { name: "C" },
        submittedAt: "t3",
        read: store.read,
        write: store.write,
      }),
    ).toEqual({ ok: false, error: "The responses Sheet kept changing while saving. Try again." });
  });

  it("refuses answers that do not fit without writing", async () => {
    const store = sheetStore(null);
    const outcome = await submitFormResponse({
      document: FORM,
      answers: {},
      submittedAt: "t",
      read: store.read,
      write: store.write,
    });
    expect(outcome).toEqual({ ok: false, error: "This question is required." });
    expect(store.writes).toHaveLength(0);
  });
});
