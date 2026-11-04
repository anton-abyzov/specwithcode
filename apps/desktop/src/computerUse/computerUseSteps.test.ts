import { describe, expect, it } from "vite-plus/test";

import {
  actionSteps,
  applicationAtPoint,
  applicationName,
  ComputerUseInputError,
  parseChord,
  PASTE_STEPS,
  screenshotSize,
  toDisplayPoint,
  toScreenshotPoint,
} from "./computerUseSteps.ts";

const laptop = { width: 1512, height: 982 };
const wide = { width: 3136, height: 1764 };

describe("screenshot scaling", () => {
  it("keeps a display that fits the cap at one pixel per point", () => {
    expect(screenshotSize(laptop)).toEqual(laptop);
    expect(toDisplayPoint(laptop, 100, 200)).toEqual({ x: 100, y: 200 });
  });

  it("scales a large display down and maps clicks back up", () => {
    const size = screenshotSize(wide);
    expect(Math.max(size.width, size.height)).toBe(1568);
    const point = toDisplayPoint(wide, size.width / 2, size.height / 2);
    expect(point.x).toBeCloseTo(wide.width / 2, 0);
    expect(point.y).toBeCloseTo(wide.height / 2, 0);
    expect(toScreenshotPoint(wide, wide.width, wide.height)).toEqual({
      x: size.width,
      y: size.height,
    });
  });

  it("clamps points onto the display", () => {
    expect(toDisplayPoint(laptop, 99_999, 99_999)).toEqual({ x: 1511, y: 981 });
  });
});

describe("parseChord", () => {
  it("reads modifiers and keys in any case and alias", () => {
    expect(parseChord("Cmd+Space")).toEqual({ modifiers: ["cmd"], keyCode: 49 });
    expect(parseChord("command+shift+4")).toEqual({ modifiers: ["cmd", "shift"], keyCode: 21 });
    expect(parseChord("option+left")).toEqual({ modifiers: ["alt"], keyCode: 123 });
    expect(parseChord("enter").keyCode).toBe(36);
    expect(parseChord("esc").keyCode).toBe(53);
    expect(parseChord("cmd+comma")).toEqual({ modifiers: ["cmd"], keyCode: 43 });
    expect(parseChord("cmd++")).toEqual({ modifiers: ["cmd"], keyCode: 24 });
  });

  it("rejects unknown keys with a message the agent can act on", () => {
    expect(() => parseChord("cmd+banana")).toThrow(ComputerUseInputError);
    expect(() => parseChord("hyper+a")).toThrow(/not a modifier/);
  });
});

describe("actionSteps", () => {
  it("moves, then presses and releases for each click of a double click", () => {
    const steps = actionSteps({ kind: "click", x: 10, y: 20, count: 2 }, laptop);
    const mouse = steps.filter((step) => step.type === "mouse");
    expect(mouse.map((step) => step.event)).toEqual([5, 1, 2, 1, 2]);
    expect(mouse.map((step) => step.clickState)).toEqual([0, 1, 1, 2, 2]);
    expect(mouse.every((step) => step.x === 10 && step.y === 20)).toBe(true);
  });

  it("uses the right-button events and holds modifiers on the click", () => {
    const steps = actionSteps(
      { kind: "click", x: 1, y: 1, button: "right", modifiers: ["cmd"] },
      laptop,
    );
    const presses = steps.filter((step) => step.type === "mouse" && step.event !== 5);
    expect(presses.map((step) => (step.type === "mouse" ? step.event : 0))).toEqual([3, 4]);
    expect(presses.every((step) => step.type === "mouse" && step.flags === 0x100000)).toBe(true);
  });

  it("drags with the button held between the two points", () => {
    const steps = actionSteps({ kind: "drag", fromX: 0, fromY: 0, toX: 120, toY: 60 }, laptop);
    const mouse = steps.filter((step) => step.type === "mouse");
    expect(mouse[1]?.event).toBe(1);
    expect(mouse.at(-1)).toMatchObject({ event: 2, x: 120, y: 60 });
    expect(mouse.slice(2, -1).every((step) => step.event === 6)).toBe(true);
  });

  it("scrolls the view under the point, one event per notch", () => {
    const steps = actionSteps(
      { kind: "scroll", x: 50, y: 50, direction: "down", amount: 5 },
      laptop,
    );
    const scrolls = steps.filter((step) => step.type === "scroll");
    expect(scrolls).toHaveLength(5);
    expect(scrolls[0]).toEqual({ type: "scroll", vertical: -4, horizontal: 0 });
  });

  it("presses a chord with modifiers down first and up last", () => {
    const steps = actionSteps({ kind: "key", keys: "cmd+shift+a", repeat: 2 }, laptop);
    const keys = steps.filter((step) => step.type === "key");
    expect(keys).toHaveLength(12);
    expect(keys.slice(0, 6).map((step) => [step.keyCode, step.down])).toEqual([
      [55, true],
      [56, true],
      [0, true],
      [0, false],
      [56, false],
      [55, false],
    ]);
  });

  it("pastes with cmd+v", () => {
    expect(
      PASTE_STEPS.filter((step) => step.type === "key").map((step) =>
        step.type === "key" ? step.keyCode : -1,
      ),
    ).toEqual([55, 9, 9, 55]);
  });
});

describe("applicationAtPoint", () => {
  const window = (
    owner: string | null,
    x: number,
    y: number,
    layer = 0,
    alpha = 1,
    width = 400,
    height = 300,
  ) => ({ owner, layer, alpha, x, y, width, height });
  const at = (windows: ReadonlyArray<ReturnType<typeof window>>, x: number, y: number) =>
    applicationAtPoint({ frontmost: "Notes", windows, screens: [laptopScreen] }, { x, y });
  // A 1512x982 display: menu bar 0..33, Dock drawn below 930.
  const laptopScreen = {
    frame: { x: 0, y: 0, width: 1512, height: 982 },
    visible: { x: 0, y: 34, width: 1512, height: 896 },
  };
  const menuBar = window("Window Server", 0, 0, 24, 1, 1512, 33);
  const dock = window("Dock", 0, 0, 20, 1, 1512, 982);

  it("picks the topmost visible window that contains the point", () => {
    const windows = [
      window("Invisible", 0, 0, 0, 0),
      window("Notes", 500, 500),
      window("Terminal", 0, 40),
      window("Finder", 0, 40),
    ];
    expect(at(windows, 10, 50)).toBe("Terminal");
    expect(at(windows, 600, 600)).toBe("Notes");
    expect(at(windows, 450, 450)).toBeUndefined();
  });

  it("counts windows above the normal layer as their own app", () => {
    const banner = window("Notification Center", 1100, 40, 23, 1, 360, 80);
    const overlay = window("SpecWithCode", 0, 40, 1000, 1, 200, 200);
    const windows = [overlay, banner, window("Terminal", 0, 0, 0, 1, 1512, 982)];
    expect(at(windows, 1200, 60)).toBe("Notification Center");
    expect(at(windows, 50, 60)).toBe("SpecWithCode");
    expect(at(windows, 600, 600)).toBe("Terminal");
  });

  it("reads the menu bar as the frontmost app's menus", () => {
    const windows = [menuBar, dock, window("Terminal", 0, 0, 0, 1, 1512, 982)];
    expect(at(windows, 100, 10)).toBe("Notes");
    expect(
      applicationAtPoint({ windows, screens: [laptopScreen] }, { x: 100, y: 10 }),
    ).toBeUndefined();
  });

  it("passes over other Window Server windows such as the cursor", () => {
    const cursor = window("Window Server", 90, 90, 2147483630, 1, 32, 32);
    expect(at([cursor, window("Terminal", 0, 40)], 100, 100)).toBe("Terminal");
  });

  it("counts the Dock only where it is drawn", () => {
    const windows = [menuBar, dock, window("Terminal", 0, 0, 0, 1, 1512, 982)];
    expect(at(windows, 700, 950)).toBe("Dock");
    expect(at(windows, 700, 500)).toBe("Terminal");
    // The row between the menu bar and the visible frame is not the Dock.
    expect(at(windows, 700, 33)).toBe("Terminal");
  });

  it("treats the far edges as outside the window", () => {
    expect(at([window("Notes", 0, 40)], 400, 50)).toBeUndefined();
    expect(at([window("Notes", 0, 40)], 399, 339)).toBe("Notes");
  });

  it("does not report a window without an owner name", () => {
    expect(at([window(null, 0, 40)], 1, 41)).toBeUndefined();
  });
});

describe("applicationName", () => {
  it("prefers the name the running app goes by", () => {
    expect(
      applicationName({
        requested: "code",
        runningName: "Code",
        displayName: "Visual Studio Code",
        bundleName: "Code",
        fileName: "Visual Studio Code",
      }),
    ).toBe("Code");
  });

  it("falls back to the display name, the bundle name, then the file name", () => {
    const bundle = { requested: "x", fileName: "Visual Studio Code" };
    expect(applicationName({ ...bundle, displayName: "VS Code", bundleName: "Code" })).toBe(
      "VS Code",
    );
    expect(applicationName({ ...bundle, displayName: " ", bundleName: "Code" })).toBe("Code");
    expect(applicationName(bundle)).toBe("Visual Studio Code");
  });

  it("keeps the requested name when nothing else is known", () => {
    expect(applicationName({ requested: " Notes " })).toBe("Notes");
  });
});
