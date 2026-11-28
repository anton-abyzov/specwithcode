import { describe, expect, it } from "vite-plus/test";

import {
  CLASSIC_PICTURE,
  encodeWithinBudget,
  fastLooksAfter,
  nextLookDelay,
  parseViewport,
  pictureFor,
  takeViewportTurn,
} from "./screenSharePicture.logic.ts";

const retina = { width: 3456, height: 2234 };

describe("screen share picture", () => {
  it("keeps slice 1's picture until a viewer says how big its window is", () => {
    expect(pictureFor(null, retina)).toEqual(CLASSIC_PICTURE);
    expect(pictureFor({ width: 2560, height: 1680, picture: "classic" }, retina)).toEqual(
      CLASSIC_PICTURE,
    );
  });

  it("fits the display into the viewer's window, between the floor and the cap", () => {
    // A 1280x840 window at pixel ratio 2: the screen scaled by min(2560/3456, 1680/2234).
    expect(pictureFor({ width: 2560, height: 1680, picture: "auto" }, retina)).toEqual({
      maxEdge: 2560,
      quality: 55,
    });
    expect(pictureFor({ width: 1200, height: 700, picture: "auto" }, retina)).toEqual({
      maxEdge: 1083,
      quality: 60,
    });
    expect(pictureFor({ width: 100, height: 60, picture: "auto" }, retina).maxEdge).toBe(640);
    expect(pictureFor({ width: 8000, height: 6000, picture: "auto" }, retina).maxEdge).toBe(2880);
  });

  it("caps low bandwidth at 1,280 px and quality 50", () => {
    expect(pictureFor({ width: 2560, height: 1680, picture: "low" }, retina)).toEqual({
      maxEdge: 1280,
      quality: 50,
    });
  });

  it("reads only well-formed viewports", () => {
    expect(parseViewport({ width: 10, height: 10, picture: "auto" })).toEqual({
      width: 10,
      height: 10,
      picture: "auto",
    });
    expect(parseViewport({ width: 1.5, height: 10, picture: "auto" })).toBeNull();
    expect(parseViewport({ width: 0, height: 10, picture: "auto" })).toBeNull();
    expect(parseViewport({ width: 99_999, height: 10, picture: "auto" })).toBeNull();
    expect(parseViewport({ width: 10, height: 10, picture: "huge" })).toBeNull();
    expect(parseViewport({ width: "10", height: 10, picture: "auto" })).toBeNull();
  });

  it("reads at most four viewports a second", () => {
    const times: Array<number> = [];
    const taken = [0, 10, 20, 30, 40, 50].map((at) => takeViewportTurn(times, at));
    expect(taken).toEqual([true, true, true, true, false, false]);
    expect(takeViewportTurn(times, 1_001)).toBe(true);
  });

  it("looks again soon while the picture changes, then slows down", () => {
    let left = fastLooksAfter(0, true);
    expect(nextLookDelay(left, "auto")).toBe(100);
    left = fastLooksAfter(left, false);
    left = fastLooksAfter(left, false);
    expect(nextLookDelay(left, "auto")).toBe(100);
    left = fastLooksAfter(left, false);
    expect(nextLookDelay(left, "auto")).toBe(330);
    expect(nextLookDelay(3, "classic")).toBe(330);
    expect(nextLookDelay(3, null)).toBe(330);
  });

  it("encodes rougher, then smaller, to stay under the budget", () => {
    const tries: Array<[number, number]> = [];
    const result = encodeWithinBudget(
      (edge, quality) => {
        tries.push([edge, quality]);
        return new Uint8Array(edge * quality);
      },
      { maxEdge: 2000, quality: 60 },
      60_000,
    );
    expect(tries).toEqual([
      [2000, 60],
      [2000, 45],
      [2000, 40],
      [1500, 40],
    ]);
    expect(result).toMatchObject({ maxEdge: 1500, quality: 40 });
    expect(encodeWithinBudget(() => new Uint8Array(10), CLASSIC_PICTURE, 5)).toBeNull();
  });
});
