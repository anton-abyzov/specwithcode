import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import {
  actionSteps,
  applicationAtPoint,
  applicationName,
  canAttemptBackgroundAxClick,
  canSafelyFallbackHidClick,
  canSafelyFallbackHidType,
  clickStepsAtPoint,
  ComputerUseInputError,
  findWindowForApplication,
  frontMirroringWindow,
  type InputStep,
  IPHONE_MIRRORING_BUNDLE_ID,
  isWindowCaptureFresh,
  MIRRORING_REPEAT_GAP_MS,
  MIRRORING_REPEAT_HOLD_MS,
  JXA_AX_ACTION_SCRIPT,
  JXA_INPUT_SCRIPT,
  JXA_MIRRORING_SCRIPT,
  JXA_WINDOWS_SCRIPT,
  latinKeystroke,
  type MirroringScene,
  mirroringActionSteps,
  mirroringPointerTarget,
  mirroringTypeSteps,
  mirroringWindowAt,
  parseChord,
  PASTE_STEPS,
  type ReplayOptions,
  screenshotSize,
  toDisplayPoint,
  toScreenshotPoint,
  toWindowDisplayPoint,
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

describe("iPhone Mirroring", () => {
  const mirroringWindow = { x: 600, y: 100, width: 360, height: 760 };
  const sceneWindow = (
    owner: string | null,
    area: { x: number; y: number; width: number; height: number },
    mirroring = false,
    layer = 0,
  ) => ({ owner, layer, alpha: 1, mirroring, ...area });
  // As macOS lists them: the menu bar and the Dock's display-wide window come before every app window.
  const fullDisplay = { x: 0, y: 0, width: 1512, height: 982 };
  const screens = [{ frame: fullDisplay, visible: { x: 0, y: 34, width: 1512, height: 896 } }];
  const systemWindows = [
    sceneWindow("Window Server", { x: 0, y: 0, width: 1512, height: 33 }, false, 24),
    sceneWindow("Dock", fullDisplay, false, 20),
    sceneWindow("Window Server", { x: 700, y: 400, width: 32, height: 32 }, false, 2147483630),
  ];
  const scene = (
    frontmostBundleId: string | null,
    area: typeof mirroringWindow = mirroringWindow,
  ): MirroringScene => ({
    frontmostBundleId,
    screens,
    windows: [
      ...systemWindows,
      sceneWindow("iPhone Mirroring", area, true),
      sceneWindow("SpecWithCode", fullDisplay),
    ],
  });
  const behind = scene("com.example.studio");
  const front = scene(IPHONE_MIRRORING_BUNDLE_ID);
  const keyOf = (step: InputStep) => (step.type === "key" ? step : undefined);

  it("finds the window only where it is the topmost one", () => {
    expect(mirroringWindowAt(behind, { x: 700, y: 410 })).toEqual(mirroringWindow);
    expect(mirroringWindowAt(behind, { x: 100, y: 100 })).toBeUndefined();
    const covered: MirroringScene = {
      frontmostBundleId: null,
      screens,
      windows: [
        sceneWindow("Notes", { x: 650, y: 150, width: 100, height: 100 }),
        ...behind.windows,
      ],
    };
    expect(mirroringWindowAt(covered, { x: 700, y: 200 })).toBeUndefined();
    expect(mirroringWindowAt(covered, { x: 700, y: 600 })).toEqual(mirroringWindow);
  });

  it("looks through the Dock's display-wide window but not where the Dock is drawn", () => {
    const tall = { x: 600, y: 20, width: 360, height: 950 };
    const reaching = scene(null, tall);
    expect(mirroringWindowAt(reaching, { x: 700, y: 500 })).toEqual(tall);
    // The Dock's strip below the visible frame, and the menu bar above it.
    expect(mirroringWindowAt(reaching, { x: 700, y: 950 })).toBeUndefined();
    expect(mirroringWindowAt(reaching, { x: 700, y: 25 })).toBeUndefined();
  });

  it("knows the front window only while iPhone Mirroring is frontmost", () => {
    expect(frontMirroringWindow(front)).toEqual(mirroringWindow);
    expect(frontMirroringWindow(behind)).toBeUndefined();
    expect(
      frontMirroringWindow({ frontmostBundleId: IPHONE_MIRRORING_BUNDLE_ID, windows: [] }),
    ).toBeUndefined();
  });

  it("leaves every other action to its usual steps", () => {
    const outside = { scene: behind };
    expect(mirroringActionSteps({ kind: "click", x: 10, y: 10 }, laptop, outside)).toBeUndefined();
    expect(
      mirroringActionSteps({ kind: "scroll", x: 10, y: 10, direction: "down" }, laptop, outside),
    ).toBeUndefined();
    expect(mirroringActionSteps({ kind: "key", keys: "return" }, laptop, outside)).toBeUndefined();
    expect(mirroringActionSteps({ kind: "type", text: "hi" }, laptop, outside)).toBeUndefined();
    expect(mirroringActionSteps({ kind: "move", x: 700, y: 410 }, laptop, outside)).toBeUndefined();
  });

  it("keeps the usual steps unchanged", () => {
    const click = actionSteps({ kind: "click", x: 10, y: 20 }, laptop);
    expect(click).toEqual([
      { type: "mouse", event: 5, button: 0, x: 10, y: 20, clickState: 0, flags: 0 },
      { type: "sleep", ms: 40 },
      { type: "mouse", event: 1, button: 0, x: 10, y: 20, clickState: 1, flags: 0 },
      { type: "mouse", event: 2, button: 0, x: 10, y: 20, clickState: 1, flags: 0 },
    ]);
    const keys = actionSteps({ kind: "key", keys: "a" }, laptop);
    expect(keys.every((step) => !("source" in step))).toBe(true);
    expect(PASTE_STEPS.every((step) => !("source" in step))).toBe(true);
  });

  it("brings the window forward, then taps with the button held", () => {
    const plan = mirroringActionSteps({ kind: "click", x: 700, y: 410 }, laptop, {
      scene: behind,
    });
    expect(plan?.activate).toBe(true);
    expect(plan?.point).toEqual({ x: 700, y: 410 });
    expect(plan?.steps[0]).toEqual({
      type: "awaitFront",
      bundleId: IPHONE_MIRRORING_BUNDLE_ID,
      ms: 1_500,
    });
    const rest = plan!.steps
      .slice(1)
      .map((step) =>
        step.type === "mouse" ? step.event : step.type === "sleep" ? `sleep ${step.ms}` : step.type,
      );
    expect(rest).toEqual([5, "sleep 40", 1, "sleep 50", 2]);
    const again = mirroringActionSteps({ kind: "click", x: 700, y: 410 }, laptop, {
      scene: front,
    });
    expect(again?.activate).toBe(false);
  });

  it("scrolls and drags on the window after it comes forward", () => {
    const scroll = { kind: "scroll", x: 700, y: 600, direction: "down", amount: 2 } as const;
    const plan = mirroringActionSteps(scroll, laptop, { scene: behind });
    expect(plan?.steps[0]?.type).toBe("awaitFront");
    expect(plan?.steps.slice(1)).toEqual(actionSteps(scroll, laptop));
    const drag = { kind: "drag", fromX: 700, fromY: 700, toX: 700, toY: 300 } as const;
    expect(mirroringActionSteps(drag, laptop, { scene: behind })?.steps.slice(1)).toEqual(
      actionSteps(drag, laptop),
    );
  });

  it("maps Latin text onto US keys, with shift held for capitals and symbols", () => {
    expect(latinKeystroke("a")).toEqual({ keyCode: 0, shift: false });
    expect(latinKeystroke("A")).toEqual({ keyCode: 0, shift: true });
    expect(latinKeystroke("4")).toEqual({ keyCode: 21, shift: false });
    expect(latinKeystroke("!")).toEqual({ keyCode: 18, shift: true });
    expect(latinKeystroke("@")).toEqual({ keyCode: 19, shift: true });
    expect(latinKeystroke("?")).toEqual({ keyCode: 44, shift: true });
    expect(latinKeystroke("\\")).toEqual({ keyCode: 42, shift: false });
    expect(latinKeystroke("|")).toEqual({ keyCode: 42, shift: true });
    // Every printable ASCII character has a key, and each key with or without shift types one.
    const printable = Array.from({ length: 0x7f - 0x20 }, (_, index) =>
      String.fromCharCode(0x20 + index),
    );
    const strokes = printable.map((char) => latinKeystroke(char));
    expect(strokes.every((stroke) => stroke !== undefined)).toBe(true);
    const distinct = new Set(strokes.map((stroke) => `${stroke?.keyCode}:${stroke?.shift}`));
    expect(distinct.size).toBe(printable.length);
    expect(latinKeystroke(" ")).toEqual({ keyCode: 49, shift: false });
    expect(latinKeystroke("\n")).toEqual({ keyCode: 36, shift: false });
    expect(latinKeystroke("ж")).toBeUndefined();
    expect(latinKeystroke("é")).toBeUndefined();
    expect(latinKeystroke("😀")).toBeUndefined();
  });

  it("types key by key from the HID state, holding shift around a capital", () => {
    const steps = mirroringTypeSteps("aB", { x: 700, y: 410 });
    expect(steps[0]?.type).toBe("awaitFront");
    expect(steps[1]).toMatchObject({ type: "mouse", event: 5, x: 700, y: 410 });
    const keys = steps.map(keyOf).filter((step) => step !== undefined);
    expect(keys.map((step) => [step.keyCode, step.down, step.flags])).toEqual([
      [0, true, 0],
      [0, false, 0],
      [56, true, 0x20000],
      [11, true, 0x20000],
      [11, false, 0x20000],
      [56, false, 0],
    ]);
    expect(keys.every((step) => step.source === "hid")).toBe(true);
  });

  it("refuses text the phone cannot take before pressing any key", () => {
    expect(() => mirroringTypeSteps("Привет", undefined)).toThrow(ComputerUseInputError);
    expect(() => mirroringTypeSteps("ok é", undefined)).toThrow(/"é".*nothing was typed/);
    expect(() =>
      mirroringActionSteps({ kind: "type", text: "日本" }, laptop, { scene: front }),
    ).toThrow(/US keyboard/);
  });

  it("puts the pointer inside the window before keys reach the phone", () => {
    expect(mirroringPointerTarget(mirroringWindow, { x: 700, y: 400 }, undefined)).toBeUndefined();
    expect(mirroringPointerTarget(mirroringWindow, { x: 5, y: 5 }, { x: 650, y: 300 })).toEqual({
      x: 650,
      y: 300,
    });
    expect(mirroringPointerTarget(mirroringWindow, { x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({
      x: 780,
      y: 480,
    });
    const plan = mirroringActionSteps({ kind: "key", keys: "cmd+1", repeat: 2 }, laptop, {
      scene: front,
      cursor: { x: 5, y: 5 },
    });
    expect(plan?.activate).toBe(false);
    expect(plan?.steps[1]).toMatchObject({ type: "mouse", event: 5, x: 780, y: 480 });
    const keys = plan!.steps.map(keyOf).filter((step) => step !== undefined);
    expect(keys).toHaveLength(8);
    expect(keys.every((step) => step.source === "hid")).toBe(true);
  });

  it("types into the phone only while iPhone Mirroring is frontmost", () => {
    const plan = mirroringActionSteps({ kind: "type", text: "Hi" }, laptop, {
      scene: front,
      cursor: { x: 700, y: 400 },
    });
    expect(plan?.steps[0]?.type).toBe("awaitFront");
    expect(plan?.steps.some((step) => step.type === "mouse")).toBe(false);
  });

  it("refuses text longer than one replay can type before pressing any key", () => {
    expect(mirroringTypeSteps("a".repeat(1_000), undefined).length).toBeGreaterThan(1_000);
    expect(() => mirroringTypeSteps("a".repeat(1_001), undefined)).toThrow(/at most 1000/);
  });

  it("handles the new steps in the input script and reads windows by bundle id", () => {
    expect(JXA_INPUT_SCRIPT).toContain('step.type === "awaitFront"');
    expect(JXA_INPUT_SCRIPT).toContain("not-frontmost");
    // After the guard passes, every later event checks the app is still in front.
    expect(JXA_INPUT_SCRIPT).toContain("guarded !== null && frontBundleId() !== guarded");
    expect(JXA_INPUT_SCRIPT).toContain("left-front");

    expect(JXA_MIRRORING_SCRIPT).toContain("visibleFrame");
    expect(JXA_INPUT_SCRIPT).toContain("CGEventSourceCreate(1)");
    expect(JXA_MIRRORING_SCRIPT).toContain("runningApplicationsWithBundleIdentifier");
    expect(JXA_MIRRORING_SCRIPT).toContain("kCGWindowOwnerPID");
  });
});

/**
 * Runs `JXA_INPUT_SCRIPT` in a sandbox whose Quartz bridge records events instead
 * of posting them; the frontmost app changes after `leaveAfter` frontmost checks.
 */
function replayWithStubs(steps: ReadonlyArray<InputStep>, leaveAfter: number) {
  interface Recorded {
    type: number;
    x?: number;
    y?: number;
    button?: number;
    key?: number;
    down?: boolean;
    hid?: boolean;
    flags: number | undefined;
    clickState: number;
  }
  const posted: Array<Recorded> = [];
  let checks = 0;
  const nsString = (value: string) => ({ isNil: () => false, js: value });
  const workspace = {
    get frontmostApplication() {
      checks++;
      const id = checks > leaveAfter ? "com.example.other" : IPHONE_MIRRORING_BUNDLE_ID;
      return { isNil: () => false, bundleIdentifier: nsString(id), localizedName: nsString(id) };
    },
  };
  const hidSource = { hid: true };
  // Flags stay undefined until CGEventSetFlags runs, so "set to 0" differs from "never set".
  const make = (event: Omit<Recorded, "flags" | "clickState">): Recorded => ({
    ...event,
    flags: undefined,
    clickState: 0,
  });
  const bridge = {
    NSWorkspace: { sharedWorkspace: workspace },
    CGEventSourceCreate: () => hidSource,
    CGEventCreateMouseEvent: (
      _: unknown,
      type: number,
      point: { x: number; y: number },
      button: number,
    ) => make({ type, x: point.x, y: point.y, button }),
    CGEventCreateKeyboardEvent: (source: unknown, key: number, down: boolean) =>
      make({ type: down ? 10 : 11, key, down, hid: source === hidSource }),
    CGEventCreateScrollWheelEvent2: () => make({ type: 22 }),
    CGEventSetIntegerValueField: (event: Recorded, _: number, value: number) => {
      event.clickState = value;
    },
    CGEventSetFlags: (event: Recorded, flags: number) => {
      event.flags = flags;
    },
    CGEventPost: (_: number, event: Recorded) => posted.push({ ...event }),
  };
  const context = NodeVM.createContext({
    ObjC: { import: () => undefined },
    $: bridge,
    delay: () => undefined,
  });
  NodeVM.runInContext(JXA_INPUT_SCRIPT, context);
  let error: string | undefined;
  try {
    (context.run as (argv: Array<string>) => string)([JSON.stringify(steps)]);
  } catch (caught) {
    error = String((caught as Error).message);
  }
  return { posted, error };
}

describe("input replay guard", () => {
  const display = { width: 1512, height: 982 };
  const mirroringWindow = { x: 600, y: 100, width: 360, height: 760 };
  const scene: MirroringScene = {
    frontmostBundleId: IPHONE_MIRRORING_BUNDLE_ID,
    windows: [
      { owner: "iPhone Mirroring", layer: 0, alpha: 1, mirroring: true, ...mirroringWindow },
    ],
  };

  it("runs usual steps unguarded, exactly as before", () => {
    const steps = actionSteps({ kind: "click", x: 10, y: 20 }, display);
    const { posted, error } = replayWithStubs(steps, 0);
    expect(error).toBeUndefined();
    expect(posted).toEqual([
      { type: 5, x: 10, y: 20, button: 0, flags: 0, clickState: 0 },
      { type: 1, x: 10, y: 20, button: 0, flags: 0, clickState: 1 },
      { type: 2, x: 10, y: 20, button: 0, flags: 0, clickState: 1 },
    ]);
  });

  it("releases the button at the last drag point when the app leaves mid-drag", () => {
    const plan = mirroringActionSteps(
      { kind: "drag", fromX: 700, fromY: 700, toX: 700, toY: 300 },
      display,
      { scene },
    )!;
    // Checks: awaitFront, move, down, then two dragged segments, then the app leaves.
    const { posted, error } = replayWithStubs(plan.steps, 5);
    expect(error).toMatch(/left-front/);
    const last = posted.at(-1)!;
    expect(last.type).toBe(2);
    expect(last.clickState).toBe(1);
    // The drag is vertical, so y tells the press point from the last drag point.
    expect(last.y).toBe(posted.at(-2)!.y);
    expect(last.y).not.toBe(posted.find((event) => event.type === 1)!.y);
    expect(last.button).toBe(0);
    expect(last.flags).toBe(0);
    expect(posted.filter((event) => event.type === 2)).toHaveLength(1);
  });

  it("releases a held capital's key before its shift, clearing shift", () => {
    const steps = mirroringTypeSteps("A", undefined);
    // Checks: awaitFront, shift down, A down, then the app leaves.
    const { posted, error } = replayWithStubs(steps, 3);
    expect(error).toMatch(/left-front/);
    expect(posted.map((event) => [event.key, event.down, event.flags, event.hid])).toEqual([
      [56, true, 0x20000, true],
      [0, true, 0x20000, true],
      [0, false, 0x20000, true],
      [56, false, 0, true],
    ]);
  });

  it("says nothing was sent when only the pointer moved", () => {
    const steps = mirroringTypeSteps("a", { x: 700, y: 400 });
    const { posted, error } = replayWithStubs(steps, 2);
    expect(error).toMatch(/not-frontmost/);
    expect(posted.map((event) => event.type)).toEqual([5]);
  });

  it("presses a repeated key on the phone exactly as many times as asked", () => {
    for (const repeat of [1, 2, 3, 5, 6, 50]) {
      const plan = mirroringActionSteps({ kind: "key", keys: "backspace", repeat }, display, {
        scene,
        cursor: { x: 700, y: 400 },
      });
      const { posted, error } = replayWithStubs(plan!.steps, Number.POSITIVE_INFINITY);
      expect(error).toBeUndefined();
      const keys = posted.filter((event) => event.key === 51);
      expect(keys.filter((event) => event.down)).toHaveLength(repeat);
      expect(keys.filter((event) => !event.down)).toHaveLength(repeat);
      // Every press is released before the next one starts, and all come from the HID state.
      expect(keys.map((event) => event.down)).toEqual(
        Array.from({ length: repeat }, () => [true, false]).flat(),
      );
      expect(keys.every((event) => event.hid)).toBe(true);
      // A repeat holds each press and paces the next like a person would; one press is sent at once.
      const sleeps = plan!.steps.filter((step) => step.type === "sleep").map((step) => step.ms);
      const paced = sleeps.filter((ms) => ms !== 40);
      expect(paced).toEqual(
        repeat === 1
          ? []
          : Array.from({ length: repeat }, (_, index) =>
              index === 0
                ? [MIRRORING_REPEAT_HOLD_MS]
                : [MIRRORING_REPEAT_GAP_MS, MIRRORING_REPEAT_HOLD_MS],
            ).flat(),
      );
    }
  });
});

describe("background computer use helpers", () => {
  it("finds the topmost standard on-screen window for an application", () => {
    const scene = {
      windows: [
        {
          owner: "Notes",
          layer: 25,
          alpha: 1,
          x: 0,
          y: 0,
          width: 100,
          height: 24,
          windowId: 1,
          pid: 10,
        },
        {
          owner: "Notes",
          layer: 0,
          alpha: 0,
          x: 10,
          y: 10,
          width: 400,
          height: 300,
          windowId: 2,
          pid: 10,
        },
        {
          owner: "SpecWithCode",
          layer: 0,
          alpha: 1,
          x: 0,
          y: 0,
          width: 1200,
          height: 800,
          windowId: 3,
          pid: 20,
        },
        {
          owner: "Notes",
          layer: 0,
          alpha: 1,
          x: 100,
          y: 120,
          width: 500,
          height: 400,
          windowId: 4,
          pid: 10,
        },
      ],
    };
    expect(findWindowForApplication(scene, "Notes")?.windowId).toBe(4);
    expect(findWindowForApplication(scene, "notes")?.windowId).toBe(4);
    expect(findWindowForApplication(scene, "Missing")).toBeUndefined();
  });

  it("maps window-relative screenshot pixels onto global display points", () => {
    const small = { x: 200, y: 150, width: 400, height: 300 };
    expect(toWindowDisplayPoint(small, 50, 75)).toEqual({ x: 250, y: 225 });
    expect(toWindowDisplayPoint(small, 999, 999)).toEqual({ x: 599, y: 449 });
    // A window larger than COMPUTER_USE_MAX_SCREENSHOT_EDGE (1568) is scaled down in the screenshot.
    const wide = { x: 100, y: 50, width: 3136, height: 1568 };
    expect(toWindowDisplayPoint(wide, 784, 392)).toEqual({ x: 100 + 1568, y: 50 + 784 });
  });

  it("only attempts background AX click for plain single left-clicks", () => {
    expect(canAttemptBackgroundAxClick({ kind: "click", x: 10, y: 10 })).toBe(true);
    expect(canAttemptBackgroundAxClick({ kind: "click", x: 10, y: 10, button: "right" })).toBe(
      false,
    );
    expect(canAttemptBackgroundAxClick({ kind: "click", x: 10, y: 10, count: 2 })).toBe(false);
    expect(canAttemptBackgroundAxClick({ kind: "click", x: 10, y: 10, modifiers: ["cmd"] })).toBe(
      false,
    );
  });

  it("builds click steps at an already-mapped display point", () => {
    const steps = clickStepsAtPoint({ x: 320, y: 240 });
    expect(steps[0]).toMatchObject({ type: "mouse", event: 5, x: 320, y: 240 });
    expect(steps.some((step) => step.type === "mouse" && step.event === 1 && step.x === 320)).toBe(
      true,
    );
  });

  it("exposes windowId and pid in JXA_WINDOWS_SCRIPT and uses void* AX bindings without AXFocused", () => {
    expect(JXA_WINDOWS_SCRIPT).toContain("kCGWindowNumber");
    expect(JXA_WINDOWS_SCRIPT).toContain("kCGWindowOwnerPID");
    expect(JXA_AX_ACTION_SCRIPT).toContain('AXUIElementCreateApplication", ["void *"');
    expect(JXA_AX_ACTION_SCRIPT).toContain("AXUIElementCopyElementAtPosition");
    expect(JXA_AX_ACTION_SCRIPT).toContain("AXUIElementIsAttributeSettable");
    expect(JXA_AX_ACTION_SCRIPT).not.toContain("AXSelectedText");
    expect(JXA_AX_ACTION_SCRIPT).toContain("AXPress");
    expect(JXA_AX_ACTION_SCRIPT).toContain("AXValue");
    expect(JXA_AX_ACTION_SCRIPT).toContain("CFRelease");
    expect(JXA_AX_ACTION_SCRIPT).toContain("ax-field-unidentifiable");
    expect(JXA_AX_ACTION_SCRIPT).toContain("AXNumberOfCharacters");
    expect(JXA_AX_ACTION_SCRIPT).toContain("charCount !== 0");
    // Never request focus during background AX clicks.
    expect(JXA_AX_ACTION_SCRIPT).not.toContain("AXFocused");
    // Input script enforces point-owner revalidation and tracks human cursor movement across steps.
    expect(JXA_INPUT_SCRIPT).toContain("checkPointOwner");
    expect(JXA_INPUT_SCRIPT).toContain("point-owner-changed");
    expect(JXA_INPUT_SCRIPT).toContain("humanMoved");
  });

  it("rejects stale window captures when a window moves, resizes, or closes", () => {
    const capture = {
      windowId: 42,
      pid: 100,
      bounds: { x: 100, y: 120, width: 500, height: 400 },
    };
    expect(
      isWindowCaptureFresh(
        {
          windows: [
            {
              owner: "Notes",
              layer: 0,
              alpha: 1,
              windowId: 42,
              pid: 100,
              x: 100,
              y: 120,
              width: 500,
              height: 400,
            },
          ],
        },
        capture,
      ),
    ).toBe(true);
    // Moved window is stale.
    expect(
      isWindowCaptureFresh(
        {
          windows: [
            {
              owner: "Notes",
              layer: 0,
              alpha: 1,
              windowId: 42,
              pid: 100,
              x: 140,
              y: 120,
              width: 500,
              height: 400,
            },
          ],
        },
        capture,
      ),
    ).toBe(false);
    // Closed window is stale.
    expect(isWindowCaptureFresh({ windows: [] }, capture)).toBe(false);
  });

  it("blocks foreground HID fallback when an occluded or different app would receive input", () => {
    const ownPid = 999;
    const occludedBySpecWithCode = {
      frontmost: "SpecWithCode",
      windows: [
        {
          owner: "SpecWithCode",
          layer: 0,
          alpha: 1,
          pid: ownPid,
          x: 0,
          y: 0,
          width: 900,
          height: 700,
        },
        { owner: "Notes", layer: 0, alpha: 1, pid: 100, x: 100, y: 100, width: 500, height: 400 },
      ],
    };
    expect(
      canSafelyFallbackHidClick(occludedBySpecWithCode, { x: 200, y: 200 }, "Notes", ownPid),
    ).toEqual({ ok: false, actualOwner: "SpecWithCode" });
    expect(canSafelyFallbackHidType(occludedBySpecWithCode, "Notes")).toEqual({
      ok: false,
      actualFrontmost: "SpecWithCode",
    });

    const visibleNotes = {
      frontmost: "Notes",
      windows: [
        { owner: "Notes", layer: 0, alpha: 1, pid: 100, x: 100, y: 100, width: 500, height: 400 },
        {
          owner: "SpecWithCode",
          layer: 0,
          alpha: 1,
          pid: ownPid,
          x: 0,
          y: 0,
          width: 900,
          height: 700,
        },
      ],
    };
    expect(canSafelyFallbackHidClick(visibleNotes, { x: 200, y: 200 }, "Notes", ownPid)).toEqual({
      ok: true,
    });
    expect(canSafelyFallbackHidType(visibleNotes, "Notes")).toEqual({ ok: true });
  });

  it("yields for active human input (including drags) and restores cursor only when human did not move", () => {
    const posted: Array<{ type: number; x?: number; y?: number }> = [];
    const delays: Array<number> = [];
    let poll = 0;
    let cursorPos = { x: 900, y: 600 };
    const bridge = {
      NSWorkspace: {
        sharedWorkspace: {
          frontmostApplication: {
            isNil: () => false,
            localizedName: { js: "Notes" },
            processIdentifier: 100,
          },
        },
      },
      CGEventSourceSecondsSinceLastEventType: (_: number, eventType: number) => {
        if (eventType === 6) {
          poll++;
          return poll <= 2 ? 0.02 : 0.5;
        }
        return 0.5;
      },
      CGEventCreate: () => ({ loc: true }),
      CGEventGetLocation: () => ({ ...cursorPos }),
      CGEventCreateMouseEvent: (_: unknown, type: number, point: { x: number; y: number }) => ({
        type,
        x: point.x,
        y: point.y,
      }),
      CGEventSetIntegerValueField: () => undefined,
      CGEventSetFlags: () => undefined,
      CGEventPost: (_: number, event: { type: number; x?: number; y?: number }) => {
        if (typeof event.x === "number" && typeof event.y === "number") {
          cursorPos = { x: event.x, y: event.y };
        }
        posted.push({ ...event });
      },
    };
    const context = NodeVM.createContext({
      ObjC: { import: () => undefined },
      $: bridge,
      delay: (sec: number) => delays.push(sec),
    });
    NodeVM.runInContext(JXA_INPUT_SCRIPT, context);
    const steps = clickStepsAtPoint({ x: 100, y: 200 });
    const options: ReplayOptions = {
      yieldForHumanInput: true,
      restoreCursor: true,
      forbidPid: 999,
    };
    (context.run as (argv: Array<string>) => string)([
      JSON.stringify(steps),
      JSON.stringify(options),
    ]);
    // Yielded twice (0.05s each) while drag was active, then ran click, then restored cursor to (900, 600).
    expect(delays.filter((d) => d === 0.05)).toHaveLength(2);
    expect(posted.at(-1)).toEqual({ type: 5, x: 900, y: 600 });
  });

  it("skips cursor restore if the human moved the pointer during replay, and aborts on forbidden PID", () => {
    const posted: Array<{ type: number; x?: number; y?: number }> = [];
    let cursorPos = { x: 900, y: 600 };
    const bridge = {
      NSWorkspace: {
        sharedWorkspace: {
          frontmostApplication: {
            isNil: () => false,
            localizedName: { js: "Notes" },
            processIdentifier: 100,
          },
        },
      },
      CGEventSourceSecondsSinceLastEventType: () => 1,
      CGEventCreate: () => ({ loc: true }),
      CGEventGetLocation: () => ({ ...cursorPos }),
      CGEventCreateMouseEvent: (_: unknown, type: number, point: { x: number; y: number }) => ({
        type,
        x: point.x,
        y: point.y,
      }),
      CGEventSetIntegerValueField: () => undefined,
      CGEventSetFlags: () => undefined,
      CGEventPost: (_: number, event: { type: number; x?: number; y?: number }) => {
        posted.push({ ...event });
        // Simulate the user grabbing the mouse during replay and moving it to (450, 450).
        cursorPos = { x: 450, y: 450 };
      },
    };
    const context = NodeVM.createContext({
      ObjC: { import: () => undefined },
      $: bridge,
      delay: () => undefined,
    });
    NodeVM.runInContext(JXA_INPUT_SCRIPT, context);
    const steps = clickStepsAtPoint({ x: 100, y: 200 });
    (context.run as (argv: Array<string>) => string)([
      JSON.stringify(steps),
      JSON.stringify({ restoreCursor: true }),
    ]);
    // Last posted event is mouse up at (100, 200), NOT a warp back to (900, 600).
    expect(posted.at(-1)).toEqual({ type: 2, x: 100, y: 200 });

    // Refuses to post when forbidPid matches frontmost app.
    const countBefore = posted.length;
    expect(() =>
      (context.run as (argv: Array<string>) => string)([
        JSON.stringify(steps),
        JSON.stringify({ forbidPid: 100 }),
      ]),
    ).toThrow(/forbidden-frontmost-pid/);
    expect(posted).toHaveLength(countBefore);
  });
});
