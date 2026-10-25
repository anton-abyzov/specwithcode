// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PROJECTS, SYSTEMS } from "../systems/fixtureData";
import { CreationRow } from "./CreationRow";
import { availableCreationKinds } from "./galleryModel";
import { NewDesignDialog, type NewDesignRequest } from "./NewDesignDialog";

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

describe("Slides in Make something new (AC-01)", () => {
  it("the gallery offers a Slides card that reports the slides kind", () => {
    const onCreate = vi.fn();
    act(() =>
      root.render(
        <CreationRow
          kinds={availableCreationKinds()}
          disabledReason={() => null}
          onCreate={onCreate}
        />,
      ),
    );
    const card = document.querySelector<HTMLButtonElement>(
      '[data-testid=design-create][data-kind="slides"]',
    );
    expect(card?.textContent).toContain("Slides");
    act(() => card!.click());
    expect(onCreate).toHaveBeenCalledWith("slides");
  });

  it("the slides dialog creates a slides document in the chosen owner", async () => {
    const onCreate = vi.fn(async (_request: NewDesignRequest) => null);
    act(() =>
      root.render(
        <NewDesignDialog
          kind="slides"
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          onCreate={onCreate}
        />,
      ),
    );
    await flush();
    const dialog = document.querySelector("[data-testid=new-design-dialog]")!;
    expect(dialog.getAttribute("data-kind")).toBe("slides");
    expect(dialog.textContent).toContain("New slides");
    const submit = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === "Create slides",
    )!;
    await act(async () => submit.click());
    await flush();
    expect(onCreate).toHaveBeenCalledWith({
      kind: "slides",
      owner: { kind: "playground" },
      title: "Untitled slides",
      designSystem: null,
      designSystemName: null,
      found: null,
    });
  });

  it("a plain design keeps the design kind", async () => {
    const onCreate = vi.fn(async (_request: NewDesignRequest) => null);
    act(() =>
      root.render(
        <NewDesignDialog
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          onCreate={onCreate}
        />,
      ),
    );
    await flush();
    const submit = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Create design",
    )!;
    await act(async () => submit.click());
    await flush();
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ kind: "design", title: "Untitled design" });
  });
});
