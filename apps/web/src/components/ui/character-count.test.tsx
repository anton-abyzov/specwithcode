// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { CharacterCount } from "./character-count";
import { Input } from "./input";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const countText = () =>
  container.querySelector('[data-slot="character-count"]')?.textContent?.replace(/^.*: /, "");

describe("CharacterCount", () => {
  it("shows used and maximum characters with grouping", () => {
    const markup = renderToStaticMarkup(<CharacterCount value="" max={8000} />);
    expect(markup).toContain("0 / 8,000");
  });

  it("warns as the field nears its limit", () => {
    expect(renderToStaticMarkup(<CharacterCount value={"x".repeat(95)} max={100} />)).toContain(
      "text-warning-foreground",
    );
    expect(renderToStaticMarkup(<CharacterCount value="x" max={100} />)).not.toContain(
      "text-warning-foreground",
    );
  });
});

describe("Input showCount", () => {
  it("counts a controlled value", () => {
    act(() => root.render(<Input value="hello" maxLength={48} showCount onChange={() => {}} />));
    expect(countText()).toBe("5 / 48");
  });

  it("follows edits to an uncontrolled field", () => {
    act(() => root.render(<Input defaultValue="ab" maxLength={200} showCount nativeInput />));
    expect(countText()).toBe("2 / 200");
    const input = container.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "abcd");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(countText()).toBe("4 / 200");
  });

  it("stays hidden without a maximum or when not asked for", () => {
    act(() => root.render(<Input value="hello" showCount onChange={() => {}} />));
    expect(countText()).toBeUndefined();
    act(() => root.render(<Input value="hello" maxLength={10} onChange={() => {}} />));
    expect(countText()).toBeUndefined();
  });

  it("reads as the field's description, never as part of its label", () => {
    act(() =>
      root.render(
        <label>
          Name
          <Input value="hi" maxLength={48} showCount aria-describedby="hint" onChange={() => {}} />
        </label>,
      ),
    );
    const count = container.querySelector('[data-slot="character-count"]')!;
    expect(count.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("input")!.getAttribute("aria-describedby")).toBe(
      `hint ${count.id}`,
    );
  });
});

describe("CharacterCount linked by id", () => {
  it("hides itself from the tree so a label's name stays stable", () => {
    expect(renderToStaticMarkup(<CharacterCount id="c" value="" max={10} />)).toContain(
      'aria-hidden="true"',
    );
    expect(renderToStaticMarkup(<CharacterCount value="" max={10} />)).not.toContain("aria-hidden");
    expect(renderToStaticMarkup(<CharacterCount count={7} max={10} />)).toContain("7 / 10");
  });
});
