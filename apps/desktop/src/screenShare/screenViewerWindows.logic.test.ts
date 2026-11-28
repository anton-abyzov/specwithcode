import { describe, expect, it } from "vite-plus/test";

import {
  isScreenViewerNavigationAllowed,
  parseViewerPlaces,
  placeViewerWindow,
  rememberViewerPlace,
  SCREEN_VIEWER_REMEMBERED,
  screenViewerWindowTitle,
  screenViewerWindowUrl,
} from "./screenViewerWindows.logic.ts";

describe("screen viewer window", () => {
  it("opens on the viewer route for one machine", () => {
    expect(screenViewerWindowUrl("studio://app/", "env one", "m1 & co")).toBe(
      "studio://app/#/screen/env%20one?name=m1%20%26%20co",
    );
  });

  it("names itself after the machine in one bounded plain line", () => {
    expect(screenViewerWindowTitle("m1")).toBe("Screen of m1");
    expect(screenViewerWindowTitle("evil‮\nname")).toBe("Screen of evil name");
    expect(screenViewerWindowTitle("x".repeat(500)).length).toBe("Screen of ".length + 120);
    expect(screenViewerWindowTitle(undefined)).toBe("Screen of another machine");
  });

  it("follows no other address", () => {
    const own = "studio://app/#/screen/m1";
    expect(isScreenViewerNavigationAllowed(own, own)).toBe(true);
    expect(isScreenViewerNavigationAllowed(own, "studio://app/#/settings")).toBe(false);
    expect(isScreenViewerNavigationAllowed(own, "https://example.com/")).toBe(false);
    expect(isScreenViewerNavigationAllowed(own, "not a url")).toBe(false);
  });

  it("remembers places per machine and forgets the oldest past the limit", () => {
    const places = parseViewerPlaces(null);
    let text = "";
    for (let index = 0; index <= SCREEN_VIEWER_REMEMBERED; index += 1)
      text = rememberViewerPlace(places, `m${index}`, { x: index, y: 0, width: 800, height: 600 });
    const read = parseViewerPlaces(text);
    expect(read.size).toBe(SCREEN_VIEWER_REMEMBERED);
    expect(read.has("m0")).toBe(false);
    expect(read.get(`m${SCREEN_VIEWER_REMEMBERED}`)?.x).toBe(SCREEN_VIEWER_REMEMBERED);
  });

  it("forgets what it cannot read", () => {
    expect(parseViewerPlaces("{").size).toBe(0);
    expect(parseViewerPlaces("[1]").size).toBe(0);
    expect(parseViewerPlaces('{"m1":{"x":"1"},"m2":{"x":1,"y":2,"width":0,"height":3}}').size).toBe(
      0,
    );
  });

  it("puts a window back where it was only when it is still on a display", () => {
    const workAreas = [{ x: 0, y: 0, width: 1512, height: 944 }];
    const saved = { x: 100, y: 100, width: 900, height: 600 };
    expect(placeViewerWindow({ saved, workAreas, openCount: 0 })).toEqual(saved);
    const gone = { x: 5000, y: 100, width: 900, height: 600 };
    const placed = placeViewerWindow({ saved: gone, workAreas, openCount: 1 });
    expect(placed).toMatchObject({ width: 1280, height: 840 });
    const second = placeViewerWindow({ saved: undefined, workAreas, openCount: 2 });
    expect("x" in placed && "x" in second && second.x - placed.x).toBe(28);
  });
});
