// @vitest-environment jsdom
import type { EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SystemFilesApi } from "./systemFilesApi";
import { fakeFilesApi } from "./testFakes";

vi.mock("~/studio/design", () => ({ design: {} }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => null }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => null }));
vi.mock("~/components/ChatMarkdown", () => ({
  default: (props: { text: string }) => <div data-testid="markdown-body">{props.text}</div>,
}));

const { OverviewReadmeView, README_PLACEHOLDER, README_TOO_LONG, splitTitle } =
  await import("./OverviewReadme");

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
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);
const button = (text: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
const click = async (element: Element) => {
  await act(async () => (element as HTMLElement).click());
  await flush();
};
async function type(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const decode = (base64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

async function render(api: SystemFilesApi, canEdit = true) {
  act(() =>
    root.render(
      <OverviewReadmeView
        environmentId={"env" as EnvironmentId}
        canEdit={canEdit}
        systemName="Acme"
        api={api}
      />,
    ),
  );
  await flush();
  await flush();
}

describe("OverviewReadme", () => {
  it("renders the README, then edits and saves it as UTF-8", async () => {
    const { api } = fakeFilesApi([
      { path: "README.md", text: "# Acme\n\nCalm and dense.", mimeType: "text/markdown" },
    ]);
    await render(api);
    expect($('[data-testid="readme"]')!.textContent).toContain("Acme");
    expect($('[data-testid="markdown-body"]')!.textContent).toContain("Calm and dense.");
    await click(button("Edit")!);
    const editor = $<HTMLTextAreaElement>('[data-testid="readme-editor"] textarea')!;
    expect(editor.value).toBe("# Acme\n\nCalm and dense.");
    await type(editor, "# Acme\n\nCalm, dense — and kind.");
    await click(button("Save")!);
    expect(api.put).toHaveBeenCalledTimes(1);
    const [path, data] = api.put.mock.calls[0]!;
    expect(path).toBe("README.md");
    expect(decode(data)).toBe("# Acme\n\nCalm, dense — and kind.");
    expect($('[data-testid="readme-editor"]')).toBeNull();
    expect($('[data-testid="markdown-body"]')!.textContent).toContain("Calm, dense — and kind.");
    expect(api.listing.refresh).toHaveBeenCalled();
  });

  it("cancels an edit without saving", async () => {
    const { api } = fakeFilesApi([{ path: "README.md", text: "# Acme" }]);
    await render(api);
    await click(button("Edit")!);
    await type($<HTMLTextAreaElement>('[data-testid="readme-editor"] textarea')!, "Changed");
    await click(button("Cancel")!);
    expect(api.put).not.toHaveBeenCalled();
    expect($('[data-testid="readme"]')!.textContent).toContain("Acme");
  });

  it("offers a starter brand book when there is no README", async () => {
    const { api } = fakeFilesApi([]);
    await render(api);
    expect($('[data-testid="readme-empty"]')!.textContent).toContain(README_PLACEHOLDER);
    expect(README_PLACEHOLDER).toBe("Write the brand book here.");
    await click(button("Start from a template")!);
    const draft = $<HTMLTextAreaElement>('[data-testid="readme-editor"] textarea')!.value;
    expect(draft.startsWith("# Acme\n")).toBe(true);
    for (const heading of ["Principles", "Using tokens", "Using components", "Accessibility"])
      expect(draft).toContain(`\n## ${heading}\n`);
  });

  it("refuses a README over 200 KB", async () => {
    const { api } = fakeFilesApi([]);
    await render(api);
    await click(button("Write it")!);
    await type(
      $<HTMLTextAreaElement>('[data-testid="readme-editor"] textarea')!,
      "é".repeat(110 * 1024),
    );
    await click(button("Save")!);
    expect($('[role="alert"]')!.textContent).toBe(README_TOO_LONG);
    expect(README_TOO_LONG).toBe(
      "That is more text than the README can keep (200 KB), so it was not saved.",
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("shows docs/*.md as guidance cards", async () => {
    const { api } = fakeFilesApi([
      { path: "README.md", text: "# Acme" },
      { path: "docs/voice.md", text: "# Voice\n\nPlain words, short sentences." },
      { path: "notes.md", text: "# Not guidance" },
    ]);
    await render(api);
    const cards = [...document.querySelectorAll('[data-testid="guidance-card"]')];
    expect(cards.map((card) => card.getAttribute("data-path"))).toEqual(["docs/voice.md"]);
    expect(cards[0]!.querySelector("h3")!.textContent).toBe("Voice");
    expect(cards[0]!.textContent).toContain("Plain words, short sentences.");
    expect(splitTitle("# Voice\n\nBody")).toEqual({ title: "Voice", body: "Body" });
  });

  it("is read-only without edit rights", async () => {
    const { api } = fakeFilesApi([{ path: "README.md", text: "# Acme" }]);
    await render(api, false);
    expect(button("Edit")).toBeNull();
    const empty = fakeFilesApi([]);
    await render(empty.api, false);
    expect($('[data-testid="readme-empty"]')!.textContent).toBe(
      "This design system has no README yet.",
    );
    expect(button("Start from a template")).toBeNull();
  });
});
