// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const router = vi.hoisted(() => ({
  navigate: vi.fn(async ({ to }: { to: string }) => {
    window.history.pushState(null, "", to);
  }),
  push: vi.fn((to: string) => window.history.pushState(null, "", to)),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
  useRouter: () => ({ history: { push: router.push } }),
}));

import { QuickGuides } from "../QuickGuides";
import { GuidedTourHost, TARGET_WAIT_MS } from "./GuidedTour";
import { GUIDED_TOUR_STEPS } from "./guidedTour.logic";
import { endGuidedTour, getGuidedTourState, startGuidedTour } from "./guidedTourStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const card = () => document.querySelector<HTMLElement>("[data-guided-tour-card]");
const overlay = () => document.querySelector<HTMLElement>("[data-guided-tour-overlay]");
const button = (name: string) =>
  [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === name)!;
const key = (name: string) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });

/** Puts one element on the page for every step's first target, as the real pages would. */
function drawTargets() {
  const page = document.createElement("div");
  page.dataset.fakePage = "";
  page.innerHTML = `
    <h2 id="sws-side-projects">Projects</h2>
    <div data-settings-nav-group="Project">Project</div>
    <div data-settings-nav-group="App">App</div>
    <section id="project-skills"><div data-settings-scroll-target>Skills</div></section>
    <div data-testid="skill-update-center"><div>search</div></div>
    <div data-testid="skills-table">table</div>
    <section id="model-track-daily"><header>Daily</header></section>
    <section id="model-track-complex"><header>Complex</header></section>
    <section id="model-track-review"><header>Review</header></section>
    <button data-guided-tour="new-chat">New chat</button>
    <section id="machines"><div data-settings-scroll-target>Machines</div></section>
    <section id="handoff-mode"><div data-settings-scroll-target>Moving</div></section>
    <div id="guided-tour">Guided tour</div>`;
  document.body.append(page);
  return page;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.history.pushState(null, "", "/somewhere?tab=1");
  // jsdom lays nothing out; give every element a box so targets count as shown.
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  router.navigate.mockClear();
  router.push.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  endGuidedTour();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(ms = 150) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("guided tour host (1486)", () => {
  it("never opens on its own", async () => {
    await act(async () => root.render(<GuidedTourHost />));
    expect(overlay()).toBeNull();
  });

  it("walks every step with Next and Back, spotlighting each target (AC-01, AC-02)", async () => {
    drawTargets();
    await act(async () => root.render(<GuidedTourHost />));
    await act(async () => startGuidedTour());
    await settle();
    expect(card()?.getAttribute("role")).toBe("dialog");
    expect(card()?.textContent).toContain("Step 1 of 14");
    expect(button("Back").disabled).toBe(true);
    expect(document.activeElement).toBe(button("Next"));

    const seen: string[] = [];
    for (let at = 0; at < GUIDED_TOUR_STEPS.length; at++) {
      const step = GUIDED_TOUR_STEPS[at]!;
      expect(overlay()?.dataset.tourStep).toBe(step.id);
      expect(window.location.pathname).toBe(step.route);
      expect(overlay()?.dataset.tourTarget).toBe(at === 0 ? "none" : "found");
      if (at > 0) expect(document.querySelector("[data-guided-tour-spotlight]")).not.toBeNull();
      seen.push(step.id);
      if (at < GUIDED_TOUR_STEPS.length - 1) {
        await act(async () => button("Next").click());
        await settle();
      }
    }
    expect(seen).toHaveLength(14);
    expect(button("Done")).toBeDefined();

    await act(async () => button("Back").click());
    await settle();
    expect(overlay()?.dataset.tourStep).toBe("hand-off");
    await key("ArrowLeft");
    await settle();
    expect(overlay()?.dataset.tourStep).toBe("machines");
    await key("ArrowRight");
    await settle();
    expect(overlay()?.dataset.tourStep).toBe("hand-off");
  });

  it("Skip tour and Esc end it and return to where it started (AC-04)", async () => {
    drawTargets();
    await act(async () => root.render(<GuidedTourHost />));
    await act(async () => startGuidedTour());
    await settle();
    await act(async () => button("Next").click());
    await settle();
    await act(async () => button("Skip tour").click());
    expect(overlay()).toBeNull();
    expect(router.push).toHaveBeenLastCalledWith("/somewhere?tab=1");

    await act(async () => startGuidedTour());
    await settle();
    const pageEscape = vi.fn();
    document.addEventListener("keydown", pageEscape);
    await key("Escape");
    expect(overlay()).toBeNull();
    expect(pageEscape).not.toHaveBeenCalled();
    expect(getGuidedTourState().open).toBe(false);
  });

  it("blocks clicks on the page under it (AC-04)", async () => {
    const page = drawTargets();
    const clicked = vi.fn();
    page.querySelector("[data-guided-tour='new-chat']")!.addEventListener("click", clicked);
    await act(async () => root.render(<GuidedTourHost />));
    await act(async () => startGuidedTour());
    await settle();
    const layer = overlay()!.firstElementChild as HTMLElement;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    // A full-window layer above the page; the headless walk checks what a real click hits.
    expect(overlay()!.className).toContain("fixed inset-0");
    expect(layer.className).toContain("inset-0");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("centres the card and marks a required target missing after the wait (AC-03)", async () => {
    await act(async () => root.render(<GuidedTourHost />));
    await act(async () => startGuidedTour());
    await settle();
    await act(async () => button("Next").click());
    await settle(TARGET_WAIT_MS + 200);
    expect(overlay()?.dataset.tourStep).toBe("projects");
    expect(overlay()?.dataset.tourTarget).toBe("missing");
    expect(card()?.dataset.side).toBe("center");
    expect(document.querySelector("[data-guided-tour-spotlight]")).toBeNull();
  });

  it("treats a missing optional target as a plain centred step (AC-03)", async () => {
    const page = drawTargets();
    page.querySelector('[data-testid="skills-table"]')!.remove();
    page.querySelector('[data-testid="skill-update-center"]')!.remove();
    await act(async () => root.render(<GuidedTourHost />));
    await act(async () => startGuidedTour());
    const switches = GUIDED_TOUR_STEPS.findIndex((step) => step.id === "skill-switches");
    for (let at = 0; at < switches; at++) {
      await settle(TARGET_WAIT_MS + 200);
      await act(async () => button("Next").click());
    }
    await settle(TARGET_WAIT_MS + 200);
    expect(overlay()?.dataset.tourStep).toBe("skill-switches");
    expect(overlay()?.dataset.tourTarget).toBe("none");
  });
});

describe("Quick guides entry (1486 AC-05)", () => {
  it("closes the dialog and starts the tour", async () => {
    await act(async () => root.render(<QuickGuides />));
    const trigger = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Quick guides",
    )!;
    await act(async () => trigger.click());
    await settle();
    const start = document.querySelector<HTMLButtonElement>("[data-guided-tour-start]");
    expect(start?.textContent?.trim()).toBe("Take the tour");
    await act(async () => start!.click());
    await settle(400);
    expect(getGuidedTourState().open).toBe(true);
    expect(getGuidedTourState().returnTo).toBe("/somewhere?tab=1");
    expect(document.querySelector('[role="dialog"][data-guided-tour-card]')).toBeNull();
    expect(
      [...document.querySelectorAll('[role="dialog"]')].some((d) =>
        d.textContent?.includes("Plan an increment"),
      ),
    ).toBe(false);
  });
});
