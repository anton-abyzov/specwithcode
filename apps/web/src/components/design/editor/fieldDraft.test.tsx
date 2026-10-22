// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { useFieldDraft } from "./fieldDraft";

function Field({ value, onCommit }: { value: string; onCommit: (text: string) => void }) {
  const field = useFieldDraft(value);
  return (
    <input
      aria-label="field"
      {...field.inputProps}
      onBlur={(event) => {
        onCommit(event.currentTarget.value);
        field.end();
      }}
    />
  );
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("useFieldDraft", () => {
  it("keeps half-typed text through a live update, then follows the value again", async () => {
    const commits: string[] = [];
    const render = (value: string) =>
      act(async () => root.render(<Field value={value} onCommit={(text) => commits.push(text)} />));
    await render("120");
    const input = host.querySelector("input")!;
    act(() => input.focus());
    act(() => type(input, "34"));
    // An agent edit or undo changes the value while the user is typing.
    await render("999");
    expect(input.value).toBe("34");
    act(() => input.blur());
    expect(commits).toEqual(["34"]);
    await render("34");
    expect(input.value).toBe("34");
    await render("50");
    expect(input.value).toBe("50");
  });
});
