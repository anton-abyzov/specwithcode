// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  BRIEF_DRAFT_LIMIT,
  BRIEF_DRAFTS_KEPT,
  DesignFromCodeDialog,
  readBriefDraft,
  writeBriefDraft,
} from "./DesignFromCodeDialog";

// The dialog renders outside a router here; the link only needs its target.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: unknown }) => (
    <a href={to} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

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
  localStorage.clear();
});

const find = (testId: string) =>
  document.body.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

function render(
  onOpenCreated: ((projectId: string) => void) | null,
  connected = true,
  worker: string | null = "Claude Opus 5.5",
  canWait = true,
) {
  const onStart = vi.fn(async () => "The design is saved, but its thread did not start.");
  act(() =>
    root.render(
      <DesignFromCodeDialog
        open
        onOpenChange={() => undefined}
        projects={[{ id: "web" as never, title: "Web app" }]}
        systems={[]}
        workerLabelFor={() => worker}
        canWaitFor={() => canWait}
        onStart={onStart}
        hasCreated={() => onOpenCreated !== null}
        onOpenCreated={onOpenCreated}
        connected={connected}
      />,
    ),
  );
  return onStart;
}

function type(text: string) {
  const brief = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(brief, text);
    brief.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const briefText = () => document.body.querySelector<HTMLTextAreaElement>("textarea")?.value;

async function chooseProject(title: string) {
  const trigger = find("design-from-code-project")!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent === title,
  )!;
  await act(async () => option.click());
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
    expect(open).toHaveBeenCalledExactlyOnceWith("web");
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

  it("offers Create design and links Settings > Providers when no provider is ready", () => {
    render(null, true, null);
    const link = document.body.querySelector<HTMLAnchorElement>(
      '[data-testid="design-from-code-providers-link"]',
    );
    expect(find("design-from-code-worker")?.textContent).toBe(
      "No provider is ready on this machine. Create design makes the design and its thread now, with your brief waiting to send. To run it, sign in to one in Settings > Providers.",
    );
    expect(link?.getAttribute("href")).toBe("/settings/providers");
    expect(find("design-from-code-start")?.disabled).toBe(false);
    expect(find("design-from-code-start")?.textContent).toBe("Create design");
  });

  it("refuses when this machine reports no provider at all", async () => {
    const onStart = render(null, true, null, false);
    expect(find("design-from-code-worker")?.textContent).toBe(
      "This machine reports no provider, so the design cannot start. Add one in Settings > Providers.",
    );
    expect(
      document.body
        .querySelector('[data-testid="design-from-code-providers-link"]')
        ?.getAttribute("href"),
    ).toBe("/settings/providers");
    expect(find("design-from-code-start")?.disabled).toBe(true);
    await start();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("creates the design without a provider, keeping the brief until it lands", async () => {
    // A brief typed earlier comes back after closing and reopening the dialog.
    render(null, true, null);
    type("A matchday settings page");
    act(() => root.unmount());
    root = createRoot(container);
    const onStart = render(null, true, null);
    expect(briefText()).toBe("A matchday settings page");

    // A failure keeps the draft and shows why.
    await start();
    expect(onStart).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ projectId: "web", brief: "A matchday settings page" }),
    );
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("did not start");
    expect(readBriefDraft("web" as never)).toBe("A matchday settings page");

    // Once the design and its thread exist, the brief lives in the thread.
    onStart.mockResolvedValueOnce(null as never);
    await start();
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(readBriefDraft("web" as never)).toBeNull();
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it("never saves one project's brief as another's when switching", async () => {
    const onStart = vi.fn(async () => null);
    act(() =>
      root.render(
        <DesignFromCodeDialog
          open
          onOpenChange={() => undefined}
          projects={[
            { id: "web" as never, title: "Web app" },
            { id: "api" as never, title: "API" },
          ]}
          systems={[]}
          initialProjectId={"web" as never}
          workerLabelFor={() => "Claude Opus 5.5"}
          onStart={onStart}
        />,
      ),
    );
    type("A matchday settings page");
    await chooseProject("API");
    // The text stays on screen while the person looks, but API has no draft of it.
    expect(briefText()).toBe("A matchday settings page");
    expect(readBriefDraft("api" as never)).toBeNull();
    await chooseProject("Web app");
    expect(briefText()).toBe("A matchday settings page");
    await start();
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "web", brief: "A matchday settings page" }),
    );
    // A started design clears its project's draft; API never had one.
    expect(readBriefDraft("web" as never)).toBeNull();
    expect(readBriefDraft("api" as never)).toBeNull();

    // An edit made while API is selected is API's draft.
    await chooseProject("API");
    type("An API status page");
    expect(readBriefDraft("api" as never)).toBe("An API status page");
    expect(readBriefDraft("web" as never)).toBeNull();
  });

  it("keeps the briefs of the most recently edited projects only", () => {
    localStorage.setItem("studio:design-from-code-brief:old", JSON.stringify("Saved long ago"));
    for (let index = 0; index < BRIEF_DRAFTS_KEPT; index += 1)
      writeBriefDraft(`p${index}` as never, `Brief ${index}`);
    // A brief saved before the order was kept goes first.
    expect(readBriefDraft("old" as never)).toBeNull();
    expect(readBriefDraft("p0" as never)).toBe("Brief 0");
    writeBriefDraft("p0" as never, "Brief 0, edited");
    writeBriefDraft("p20" as never, "Brief 20");
    expect(readBriefDraft("p0" as never)).toBe("Brief 0, edited");
    expect(readBriefDraft("p1" as never)).toBeNull();
    const kept = Object.keys(localStorage).filter((key) =>
      key.startsWith("studio:design-from-code-brief:"),
    );
    expect(kept).toHaveLength(BRIEF_DRAFTS_KEPT);
    // An emptied brief leaves the order too, so it frees its place.
    writeBriefDraft("p20" as never, "");
    writeBriefDraft("p21" as never, "Brief 21");
    expect(readBriefDraft("p2" as never)).toBe("Brief 2");
  });

  it("caps a saved brief and drops an empty one", () => {
    writeBriefDraft("web" as never, "x".repeat(BRIEF_DRAFT_LIMIT + 50));
    expect(readBriefDraft("web" as never)?.length).toBe(BRIEF_DRAFT_LIMIT);
    writeBriefDraft("web" as never, "   ");
    expect(readBriefDraft("web" as never)).toBeNull();
    expect(readBriefDraft("other" as never)).toBeNull();
  });
});
