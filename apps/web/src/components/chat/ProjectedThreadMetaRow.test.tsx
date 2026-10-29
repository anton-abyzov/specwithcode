// @vitest-environment jsdom
import * as DateTime from "effect/DateTime";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProjectedThreadMetaRow } from "./ProjectedThreadMetaRow";

type Props = ComponentProps<typeof ProjectedThreadMetaRow>;
const iso = (minute: number) => `2026-10-28T12:${String(minute).padStart(2, "0")}:00.000Z`;
const run = (id: string, start: number | null, end: number | null, status = "completed") => ({
  id,
  status,
  startedAt: start === null ? null : DateTime.makeUnsafe(iso(start)),
  completedAt: end === null ? null : DateTime.makeUnsafe(iso(end)),
});
const current = (id: string, start: number | null, end: number | null, status = "completed") => ({
  id,
  status,
  startedAt: start === null ? null : iso(start),
  completedAt: end === null ? null : iso(end),
});
let container: HTMLDivElement;
let root: Root;
let props: Props;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(iso(30)));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = {
    origin: null,
    folder: null,
    run: current("latest", 20, 21),
    projection: { runs: [run("old", 0, 5), run("latest", 20, 21)] },
    historyStatus: "live",
    hasMoreHistory: false,
    pendingBackgroundTasks: [],
    isWorking: false,
    hasActiveThread: true,
    pullRequests: [],
    onOpenPullRequest: () => {},
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const trigger = () => container.querySelector<HTMLButtonElement>('[data-thread-meta="duration"]')!;
const details = () => document.querySelector<HTMLElement>("[data-thread-timing-details]")!;
const value = (label: string) =>
  [...details().querySelectorAll("dt")].find((node) => node.textContent === label)
    ?.nextElementSibling?.textContent;
async function render(next: Partial<Props> = {}) {
  props = { ...props, ...next };
  await act(async () => root.render(<ProjectedThreadMetaRow {...props} />));
}
async function open() {
  await act(async () => trigger().click());
}

describe("ChatView's real projected timing metadata boundary", () => {
  it("maps Effect DateTime runs and updates partial history without counting between-turn gaps", async () => {
    await render({ hasMoreHistory: true });
    expect(trigger().textContent).toContain("Last turn 1m");
    await open();
    expect(value("Recorded turn elapsed")).toBe("6m");
    expect(value("Turns with timing")).toBe("2 of 2 recorded");
    expect(details().textContent).toContain("Only the available history is included");
    await render({ hasMoreHistory: false });
    expect(details().textContent).not.toContain("Only the available history is included");
    expect(value("Recorded turn elapsed")).toBe("6m");
  });

  it("keeps disconnected and absent projections explicitly partial", async () => {
    await render({ historyStatus: "loading" });
    await open();
    expect(details().textContent).toContain("Only the available history is included");
    await render({ historyStatus: "live", projection: null });
    expect(value("Recorded turn elapsed")).toBe("1m");
    expect(value("Turns with timing")).toBe("1 of 1 recorded");
    expect(details().textContent).toContain("Only the available history is included");
  });

  it("recomputes actual displayed totals as a live run settles and a follow-up starts", async () => {
    await render({
      run: current("first", 20, null, "running"),
      projection: { runs: [run("first", 20, null, "running")] },
      isWorking: true,
    });
    expect(trigger().textContent).toContain("Running · 10m elapsed");
    await open();
    expect(value("Recorded turn elapsed")).toBe("10m");
    await render({
      run: current("first", 20, 23),
      projection: { runs: [run("first", 20, 23)] },
      isWorking: false,
    });
    expect(trigger().textContent).toContain("Last turn 3m");
    expect(value("Recorded turn elapsed")).toBe("3m");
    await render({
      run: current("followup", 28, null, "running"),
      projection: { runs: [run("first", 20, 23), run("followup", 28, null, "running")] },
      isWorking: true,
    });
    expect(trigger().textContent).toContain("Running · 2m elapsed");
    expect(value("Recorded turn elapsed")).toBe("5m");
    expect(value("Turns with timing")).toBe("2 of 2 recorded");
  });

  it("shows settled monitoring only for an active thread and suppresses it while working", async () => {
    await render({ pendingBackgroundTasks: [{ taskId: "checks", kind: "monitor" }] });
    expect(trigger().textContent).toContain("Watching");
    await open();
    expect(value("Recorded turn elapsed")).toBe("6m");
    await render({ isWorking: true });
    expect(trigger().textContent).toContain("Last turn 1m");
    await render({ isWorking: false, hasActiveThread: false });
    expect(trigger().textContent).toContain("Last turn 1m");
  });

  it("preserves held queues and null timestamps without inventing elapsed time", async () => {
    await render({
      run: { ...current("queued", null, null, "queued"), queueHeld: true },
      projection: { runs: [{ ...run("queued", null, null, "queued"), queueHeld: true }] },
      isWorking: true,
    });
    expect(trigger().textContent).toContain("Queue held");
    await open();
    expect(value("Current turn elapsed")).toBe("Not started");
    expect(value("Recorded turn elapsed")).toBe("Not recorded");
  });
});
