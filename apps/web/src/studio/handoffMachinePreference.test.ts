// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  handoffMachinePreferenceKey,
  handoffMachineStatus,
  mirroredProjectFolder,
  parseHandoffMachinePreference,
  pickHandoffMachine,
  readMachinesSeen,
  recordMachinesSeen,
  writeHandoffMachinePreference,
  type HandoffMachine,
} from "./handoffMachinePreference";

const machine = (id: string, overrides: Partial<HandoffMachine> = {}): HandoffMachine => ({
  id,
  label: id.toUpperCase(),
  online: true,
  unavailable: null,
  workersAllowed: false,
  hasProjectFolder: false,
  lastOnlineAt: null,
  ...overrides,
});
const none = { remembered: null, lastUsed: null };

describe("handoff machine preselection", () => {
  it("prefers the remembered machine, then the last handoff target", () => {
    const machines = [machine("m1", { workersAllowed: true }), machine("m2"), machine("m3")];
    expect(pickHandoffMachine(machines, { remembered: "m3", lastUsed: "m2" })).toBe("m3");
    expect(pickHandoffMachine(machines, { remembered: null, lastUsed: "m2" })).toBe("m2");
  });

  it("skips a remembered machine that cannot take work right now", () => {
    const machines = [
      machine("m1", { online: false, unavailable: "Connect first" }),
      machine("m2", { workersAllowed: true }),
    ];
    expect(pickHandoffMachine(machines, { remembered: "m1", lastUsed: null })).toBe("m2");
  });

  it("picks the only online machine allowed for workers", () => {
    const machines = [
      machine("m1", { hasProjectFolder: true }),
      machine("m2", { workersAllowed: true }),
      machine("m3", { online: false, unavailable: "Connect first", workersAllowed: true }),
    ];
    expect(pickHandoffMachine(machines, none)).toBe("m2");
  });

  it("otherwise picks the most recently online machine", () => {
    expect(
      pickHandoffMachine(
        [
          machine("m1", { online: false, unavailable: "Connect first", lastOnlineAt: 10 }),
          machine("m2", { online: false, unavailable: "Connect first", lastOnlineAt: 30 }),
          machine("m3", { online: false, unavailable: "Connect first" }),
        ],
        none,
      ),
    ).toBe("m2");
    expect(
      pickHandoffMachine(
        [
          machine("m1", { online: false, unavailable: "Connect first", lastOnlineAt: 99 }),
          machine("m2"),
          machine("m3", { hasProjectFolder: true }),
        ],
        none,
      ),
    ).toBe("m3");
    expect(pickHandoffMachine([], none)).toBeNull();
  });

  it("describes online state and whether the project folder is saved", () => {
    expect(handoffMachineStatus(machine("m1", { hasProjectFolder: true }))).toBe(
      "Online · Project folder saved",
    );
    expect(
      handoffMachineStatus(machine("m1", { online: false, unavailable: "Connect first" })),
    ).toBe("Offline · No project folder yet");
    expect(handoffMachineStatus(machine("m1", { unavailable: "Permission required" }))).toBe(
      "Online · No project folder yet · Permission required",
    );
  });

  it("mirrors home-relative checkout paths", () => {
    expect(mirroredProjectFolder("/Users/anton/Projects/github/specweave/")).toBe(
      "~/Projects/github/specweave",
    );
    expect(mirroredProjectFolder("/home/dev/code/app")).toBe("~/code/app");
    expect(mirroredProjectFolder("/srv/app")).toBe("/srv/app");
    expect(mirroredProjectFolder("C:\\Users\\a\\app")).toBeNull();
  });
});

describe("handoff machine preference storage", () => {
  beforeEach(() => localStorage.clear());

  it.each([null, "", "{", "[]", "1", '{"remembered":1}'])("ignores malformed state %s", (value) => {
    expect(parseHandoffMachinePreference(value)).toEqual(none);
  });

  it("writes, merges and clears per source project", () => {
    const key = handoffMachinePreferenceKey("m4", "p");
    expect(key).not.toBe(handoffMachinePreferenceKey("m1", "p"));
    writeHandoffMachinePreference(key, { lastUsed: "m1" });
    expect(writeHandoffMachinePreference(key, { remembered: "m3" })).toEqual({
      remembered: "m3",
      lastUsed: "m1",
    });
    writeHandoffMachinePreference(key, { remembered: null, lastUsed: null });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("records when machines were last seen online", () => {
    recordMachinesSeen(["m1", "m3"], 100);
    recordMachinesSeen(["m3"], 200);
    expect(readMachinesSeen()).toEqual({ m1: 100, m3: 200 });
  });
});
