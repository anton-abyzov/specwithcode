// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PROJECTS, SYSTEMS } from "../systems/fixtureData";
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

describe("NewDesignDialog presets", () => {
  it("creates in the preselected owner with the preselected system", async () => {
    const onCreate = vi.fn(async (_request: NewDesignRequest) => null);
    act(() =>
      root.render(
        <NewDesignDialog
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          onCreate={onCreate}
          initialOwner={{ kind: "project", projectId: "atlas-web" as never }}
          initialSystemId={"weave" as never}
        />,
      ),
    );
    await flush();
    const submit = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Create design",
    )!;
    await act(async () => submit.click());
    await flush();
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      owner: { kind: "project", projectId: "atlas-web" },
      designSystem: "weave",
    });
  });
});
