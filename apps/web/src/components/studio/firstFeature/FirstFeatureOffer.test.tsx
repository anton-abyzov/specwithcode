// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const { FirstFeatureOfferCard } = await import("./FirstFeatureOffer");
const { firstFeatureOffer } = await import("./firstFeature.logic");

describe("FirstFeatureOfferCard (AC-11, AC-12, AC-20)", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onStart = vi.fn();
  const onDismiss = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onStart.mockClear();
    onDismiss.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const offer = (over: Partial<Parameters<typeof firstFeatureOffer>[0]> = {}) =>
    firstFeatureOffer({
      supported: true,
      finishedBefore: false,
      dismissed: false,
      agentReady: true,
      projects: [],
      ...over,
    });
  async function show(value: ReturnType<typeof offer>) {
    await act(async () =>
      root.render(<FirstFeatureOfferCard offer={value} onStart={onStart} onDismiss={onDismiss} />),
    );
  }
  const title = () => container.querySelector("h2")?.textContent;
  const action = () =>
    container.querySelector<HTMLButtonElement>("[data-first-feature-offer-action]");

  it("shows one card with its title and one action, naming no time", async () => {
    await show(offer());
    expect(title()).toBe("Build a first feature");
    expect(container.textContent).toContain(
      "Your agents plan and build one small feature and another model reviews it, on your own plans.",
    );
    expect(container.textContent).not.toMatch(/minute/i);
    expect(container.querySelectorAll("[data-first-feature-offer-action]")).toHaveLength(1);
    expect(action()!.textContent).toBe("Try a first feature");
    action()!.click();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("asks for an agent first", async () => {
    await show(offer({ agentReady: false }));
    expect(action()!.textContent).toBe("Sign in an agent first");
  });

  it("continues the sample in progress", async () => {
    await show(
      offer({
        projects: [
          {
            title: "First feature",
            workspaceSettings: {
              sample: "first-feature",
              firstFeatureGuide: { started: "2026-11-18T10:00:00.000Z" },
            },
          },
        ],
      }),
    );
    expect(title()).toBe("Continue your first feature");
    expect(action()!.textContent).toBe("Open it");
  });

  it("is absent without the server's key, once finished or dismissed", async () => {
    for (const hidden of [
      offer({ supported: false }),
      offer({ finishedBefore: true }),
      offer({ dismissed: true }),
    ]) {
      await show(hidden);
      expect(container.querySelector("[data-first-feature-offer]")).toBeNull();
    }
  });

  it("can be dismissed", async () => {
    await show(offer());
    container
      .querySelector<HTMLButtonElement>('[aria-label="Dismiss Build a first feature"]')!
      .click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
