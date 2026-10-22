// @vitest-environment jsdom
import type {
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DesignFromCodeDialog } from "../DesignFromCodeDialog";
import { NewDesignDialog } from "../gallery/NewDesignDialog";
import type { CopyOutcome } from "./DesignSystemPicker";
import { PROJECTS, SYSTEMS } from "./fixtureData";

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

/** The design system picker is the last select in both dialogs. */
async function openSystemPicker() {
  const triggers = document.body.querySelectorAll<HTMLElement>('[data-slot="select-trigger"]');
  const trigger = triggers[triggers.length - 1]!;
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  await flush();
}

const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

const copied = () =>
  vi.fn(async (_system: DesignSystemSummary, _to: DesignOwnerInput): Promise<CopyOutcome> => ({
    ok: true,
    systemId: "weave-2" as DesignSystemId,
    name: "Weave",
  }));

describe("new-design dialogs use the design system picker (AC-07)", () => {
  it("New design offers another owner's system as a copy into the playground", async () => {
    const onCopySystem = copied();
    act(() =>
      root.render(
        <NewDesignDialog
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          onCreate={async () => null}
          onCopySystem={onCopySystem}
        />,
      ),
    );
    await openSystemPicker();
    const weave = options().find((option) => option.textContent?.startsWith("Weave"))!;
    expect(weave.textContent).toContain("Copy into Playground");
    await act(async () => weave.click());
    await flush();
    expect(onCopySystem).toHaveBeenCalledOnce();
    expect(onCopySystem.mock.calls[0]![0].ref.systemId).toBe("weave");
    expect(onCopySystem.mock.calls[0]![1]).toEqual({ kind: "playground" });
  });

  it("Design from code copies into the chosen project", async () => {
    const onCopySystem = copied();
    act(() =>
      root.render(
        <DesignFromCodeDialog
          open
          onOpenChange={() => undefined}
          initialProjectId={"borealis-api" as never}
          projects={PROJECTS}
          systems={SYSTEMS}
          workerLabelFor={() => "Claude Opus 5.5"}
          onStart={async () => null}
          onCopySystem={onCopySystem}
        />,
      ),
    );
    await openSystemPicker();
    const weave = options().find((option) => option.textContent?.startsWith("Weave"))!;
    expect(weave.textContent).toContain("Copy into Borealis API");
    await act(async () => weave.click());
    await flush();
    expect(onCopySystem.mock.calls[0]![1]).toEqual({
      kind: "project",
      projectId: "borealis-api",
    });
  });

  it("offers no copies when the caller cannot copy", async () => {
    act(() =>
      root.render(
        <NewDesignDialog
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          onCreate={async () => null}
        />,
      ),
    );
    await openSystemPicker();
    expect(options().some((option) => option.textContent?.includes("Copy into"))).toBe(false);
  });
});
