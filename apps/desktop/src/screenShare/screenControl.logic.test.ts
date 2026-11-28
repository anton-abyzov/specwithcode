// @effect-diagnostics nodeBuiltinImport:off -- The test reads the helper's source to compare key tables.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  SCREEN_SHARE_INPUT_MAX_EVENTS,
  SCREEN_SHARE_INPUT_PER_SECOND,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CONTROL_BROWSER_BUNDLE_IDS,
  CONTROL_KEY_CODES,
  HeldInput,
  parseHelperLine,
  parseInputRecord,
  takeInputTurn,
  toDisplayPoint,
  toHelperEvents,
} from "./screenControl.logic.ts";

const helperSource = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "../../../../native/screen-control/main.swift"),
  "utf8",
);

describe("screen control rules", () => {
  it("knows exactly the keys the helper can press", () => {
    const table = helperSource.slice(
      helperSource.indexOf("let keyCodes"),
      helperSource.indexOf("let modifierFlags"),
    );
    const swiftKeys = new Set(
      [...table.matchAll(/"([A-Za-z0-9]+)":\s*0x/g)].map((match) => match[1]),
    );
    expect([...swiftKeys].sort()).toEqual([...CONTROL_KEY_CODES].sort());
  });

  it("reads well-formed input and nothing else", () => {
    const record = {
      displayId: "1",
      events: [
        { t: "move", x: 0.5, y: 0.25 },
        { t: "button", button: "right", down: false, x: 1.02, y: 0 },
        { t: "scroll", dx: 3, dy: -40, x: 0, y: 1 },
        { t: "key", code: "MetaLeft", down: true },
      ],
    };
    expect(parseInputRecord(record)).toEqual(record);
    const bad = [
      { displayId: 1, events: [] },
      { displayId: "1", events: "move" },
      { displayId: "1", events: [{ t: "move", x: 2, y: 0 }] },
      { displayId: "1", events: [{ t: "move", x: Number.NaN, y: 0 }] },
      { displayId: "1", events: [{ t: "button", button: "back", down: true, x: 0, y: 0 }] },
      { displayId: "1", events: [{ t: "scroll", dx: 1e9, dy: 0, x: 0, y: 0 }] },
      { displayId: "1", events: [{ t: "key", code: "Power", down: true }] },
      { displayId: "1", events: [{ t: "text", text: "hello" }] },
      {
        displayId: "1",
        events: Array.from({ length: SCREEN_SHARE_INPUT_MAX_EVENTS + 1 }, () => ({
          t: "move",
          x: 0,
          y: 0,
        })),
      },
      { displayId: "x".repeat(129), events: [] },
    ];
    for (const each of bad) expect(parseInputRecord(each)).toBeNull();
  });

  it("reads a bounded number of input records a second", () => {
    const times: Array<number> = [];
    let taken = 0;
    for (let index = 0; index < SCREEN_SHARE_INPUT_PER_SECOND + 10; index += 1)
      if (takeInputTurn(times, 1_000 + index)) taken += 1;
    expect(taken).toBe(SCREEN_SHARE_INPUT_PER_SECOND);
    expect(takeInputTurn(times, 2_000)).toBe(true);
  });

  it("puts a frame fraction on the display, never past its last point", () => {
    const display = { x: 1512, y: -200, width: 2560, height: 1440 };
    expect(toDisplayPoint(display, 0, 0)).toEqual({ x: 1512, y: -200 });
    expect(toDisplayPoint(display, 0.5, 0.5)).toEqual({ x: 2792, y: 520 });
    expect(toDisplayPoint(display, 1.05, -0.05)).toEqual({ x: 4071, y: -200 });
    expect(
      toHelperEvents(display, [
        { t: "key", code: "KeyQ", down: false },
        { t: "scroll", dx: 1, dy: 2, x: 0, y: 0 },
      ]),
    ).toEqual([
      { t: "key", code: "KeyQ", down: false },
      { t: "scroll", dx: 1, dy: 2, x: 1512, y: -200 },
    ]);
  });

  it("remembers what is held until it is let go or taken", () => {
    const held = new HeldInput();
    held.note([
      { t: "key", code: "ShiftLeft", down: true },
      { t: "key", code: "KeyA", down: true },
      { t: "key", code: "KeyA", down: false },
      { t: "button", button: "left", down: true, x: 0, y: 0 },
    ]);
    expect(held.any).toBe(true);
    expect(held.take()).toEqual({ keys: ["ShiftLeft"], buttons: ["left"] });
    expect(held.any).toBe(false);
    expect(held.take()).toEqual({ keys: [], buttons: [] });
  });

  it("reads only the helper's own replies", () => {
    expect(parseHelperLine('{"t":"ready","trusted":true}')).toEqual({ t: "ready", trusted: true });
    expect(parseHelperLine('{"t":"ready"}')).toEqual({ t: "ready", trusted: false });
    expect(parseHelperLine('{"t":"gate","blocked":null}')).toEqual({ t: "gate", blocked: null });
    expect(parseHelperLine('{"t":"gate","blocked":7}')).toBeNull();
    expect(parseHelperLine('{"t":"released"}')).toEqual({ t: "released" });
    expect(parseHelperLine("not json")).toBeNull();
  });

  it("lists browsers by bundle identifier", () => {
    expect(CONTROL_BROWSER_BUNDLE_IDS).toContain("com.google.Chrome");
    expect(CONTROL_BROWSER_BUNDLE_IDS).toContain("com.apple.Safari");
    for (const id of CONTROL_BROWSER_BUNDLE_IDS) expect(id).toMatch(/^[A-Za-z0-9.-]+$/);
  });
});
