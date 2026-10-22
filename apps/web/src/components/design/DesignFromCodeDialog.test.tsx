// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DesignFromCodeDialog } from "./DesignFromCodeDialog";

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

const find = (testId: string) =>
  document.body.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

function render(onOpenCreated: (() => void) | null, connected = true) {
  const onStart = vi.fn(async () => "The design is saved, but its thread did not start.");
  act(() =>
    root.render(
      <DesignFromCodeDialog
        open
        onOpenChange={() => undefined}
        projects={[{ id: "web" as never, title: "Web app" }]}
        systems={[]}
        workerLabelFor={() => "Claude Opus 5.5"}
        onStart={onStart}
        onOpenCreated={onOpenCreated}
        connected={connected}
      />,
    ),
  );
  return onStart;
}

async function start() {
  await act(async () => {
    find("design-from-code-start")?.click();
  });
}

describe("DesignFromCodeDialog", () => {
  it("offers Open design beside the error once a design exists", async () => {
    const open = vi.fn();
    render(open);
    await start();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("did not start");
    find("design-from-code-open")?.click();
    expect(open).toHaveBeenCalledOnce();
  });

  it("keeps Start design off until the machine is connected", async () => {
    const onStart = render(null, false);
    expect(find("design-from-code-start")?.disabled).toBe(true);
    expect(find("design-from-code-connecting")?.textContent).toContain(
      "Connecting to this machine",
    );
    await start();
    expect(onStart).not.toHaveBeenCalled();

    render(null, true);
    expect(find("design-from-code-connecting")).toBeNull();
    expect(find("design-from-code-start")?.disabled).toBe(false);
  });

  it("shows no Open design when nothing was created", async () => {
    render(null);
    await start();
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(find("design-from-code-open")).toBeNull();
  });
});
