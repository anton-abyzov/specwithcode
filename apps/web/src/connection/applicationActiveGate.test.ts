import { describe, expect, it } from "vite-plus/test";

import {
  APPLICATION_ACTIVE_MIN_INTERVAL_MS,
  createApplicationActiveGate,
  DESKTOP_BRIEF_HIDE_MS,
} from "./applicationActiveGate";

function clock() {
  let at = 1_000_000;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

describe("application active wakeups", () => {
  it("does not wake a desktop window shown again after a brief hide", () => {
    const time = clock();
    const gate = createApplicationActiveGate({ desktop: true, now: time.now });
    gate.hidden();
    time.advance(DESKTOP_BRIEF_HIDE_MS - 1);
    expect(gate.shown()).toBe(false);
  });

  it("wakes a desktop window after a long hide, once per burst", () => {
    const time = clock();
    const gate = createApplicationActiveGate({ desktop: true, now: time.now });
    gate.hidden();
    time.advance(DESKTOP_BRIEF_HIDE_MS);
    expect(gate.shown()).toBe(true);
    gate.hidden();
    time.advance(DESKTOP_BRIEF_HIDE_MS);
    expect(gate.shown()).toBe(true);
    // A show with no hide before it (the first event of a page) still wakes.
    time.advance(APPLICATION_ACTIVE_MIN_INTERVAL_MS);
    expect(gate.shown()).toBe(true);
  });

  it("wakes a browser tab after any hide, but once for shows in quick succession", () => {
    const time = clock();
    const gate = createApplicationActiveGate({ desktop: false, now: time.now });
    gate.hidden();
    time.advance(10);
    expect(gate.shown()).toBe(true);
    gate.hidden();
    time.advance(10);
    expect(gate.shown()).toBe(false);
    time.advance(APPLICATION_ACTIVE_MIN_INTERVAL_MS);
    gate.hidden();
    expect(gate.shown()).toBe(true);
  });

  it("measures a hide from when it began, not from a repeated hidden event", () => {
    const time = clock();
    const gate = createApplicationActiveGate({ desktop: true, now: time.now });
    gate.hidden();
    time.advance(DESKTOP_BRIEF_HIDE_MS - 10);
    gate.hidden();
    time.advance(20);
    expect(gate.shown()).toBe(true);
  });
});
