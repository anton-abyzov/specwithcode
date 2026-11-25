import { describe, expect, it } from "vite-plus/test";

import { isMainFrameNavigation } from "./mainFrameNavigation.ts";

describe("isMainFrameNavigation", () => {
  const mainFrame = { name: "main" };

  it("is true only for a navigation of the main frame", () => {
    expect(
      isMainFrameNavigation({ isNavigationRequest: () => true, frame: () => mainFrame }, mainFrame),
    ).toBe(true);
    expect(
      isMainFrameNavigation({ isNavigationRequest: () => true, frame: () => ({}) }, mainFrame),
    ).toBe(false);
    expect(
      isMainFrameNavigation(
        { isNavigationRequest: () => false, frame: () => mainFrame },
        mainFrame,
      ),
    ).toBe(false);
  });

  // A page's service worker, or a navigation issued before its frame is attached, makes
  // Playwright throw from frame(). The listener runs outside any Effect, so a throw there would
  // end the whole server.
  it("answers false instead of throwing when the request has no frame yet", () => {
    const frameless = {
      isNavigationRequest: () => true,
      frame: () => {
        throw new Error("Frame for this navigation request is not available");
      },
    };
    expect(isMainFrameNavigation(frameless, mainFrame)).toBe(false);
  });
});
