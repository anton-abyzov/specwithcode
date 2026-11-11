// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PathField } from "./PathField";

const NAMES = ["Desktop", "Documents", "Projects"];
const MAC = { windows: false, ignoresCase: true };
let container: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn();
const onCancel = vi.fn();

function Field({ start }: { start: string }) {
  const [value, setValue] = useState(start);
  return (
    <PathField
      aria-label="Folder path"
      value={value}
      onChange={setValue}
      names={NAMES}
      machine={MAC}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
const field = () => container.querySelector<HTMLInputElement>("input")!;
/** Types as a person does: the new text replaces any selection, caret at the end. */
async function typeTo(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field(), value);
    field().setSelectionRange(value.length, value.length);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(name: string) {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  onSubmit.mockReset();
  onCancel.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Field start="~/" />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("completes the name being typed and selects the added part", async () => {
  await typeTo("~/P");
  expect(field().value).toBe("~/Projects");
  expect([field().selectionStart, field().selectionEnd]).toEqual([3, 10]);
  // The next letter replaces the selection and is completed again.
  await typeTo("~/Pr");
  expect(field().value).toBe("~/Projects");
  expect(field().selectionStart).toBe(4);
});

it("does not complete again after the completion is deleted", async () => {
  await typeTo("~/Do");
  expect(field().value).toBe("~/Documents");
  await typeTo("~/Do");
  expect(field().value).toBe("~/Do");
  await typeTo("~/D");
  expect(field().value).toBe("~/D");
});

it("leaves a name with no match alone", async () => {
  await typeTo("~/x");
  expect(field().value).toBe("~/x");
});

it("cleans up a pasted path and replaces what was there", async () => {
  await act(async () => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, {
      clipboardData: { getData: () => '"/Users/you/My Project"\n' },
    });
    field().dispatchEvent(event);
  });
  expect(field().value).toBe("/Users/you/My Project");
});

it("Enter confirms the trimmed path and Escape leaves", async () => {
  await typeTo("~/x ");
  await key("Enter");
  expect(onSubmit).toHaveBeenCalledWith("~/x");
  await key("Escape");
  expect(onCancel).toHaveBeenCalledTimes(1);
});
