import { describe, expect, it } from "vite-plus/test";

import {
  chromeRowState,
  isDefaultProfileName,
  versionOlder,
  type ChromeRowInput,
  type ChromeRowStatus,
} from "./chromeRowState.logic";

const status = (overrides: Partial<ChromeRowStatus> = {}): ChromeRowStatus => ({
  bundledVersion: "1.4.0",
  profiles: [],
  ...overrides,
});
const input = (overrides: Partial<ChromeRowInput> = {}): ChromeRowInput => ({
  online: true,
  teamRulesLocked: false,
  allowed: true,
  status: status(),
  codeHandedOut: false,
  ...overrides,
});
const work = { id: "p1", label: "Work", extensionVersion: "1.4.0", fromStore: true };

describe("chromeRowState", () => {
  it.each([
    ["offline", input({ online: false, status: null }), "offline", false],
    ["team rules", input({ teamRulesLocked: true }), "team-rules", false],
    ["not allowed", input({ allowed: false, status: null }), "not-allowed", false],
    ["loading", input({ status: null }), "loading", false],
    ["Chrome not found", input({ status: status({ chromeInstalled: false }) }), "chrome-missing", false],
    ["not set up", input(), "not-set-up", true],
    ["a server that does not say counts Chrome as installed", input(), "not-set-up", true],
    ["waiting for Chrome", input({ codeHandedOut: true }), "waiting", true],
    ["paired", input({ status: status({ profiles: [work], paired: true }) }), "paired", true],
    [
      "paired, not answering",
      input({ status: status({ profiles: [], paired: true }) }),
      "not-answering",
      true,
    ],
    [
      "waiting for your approval",
      input({
        status: status({
          profiles: [work],
          peers: [{ id: "g1", machine: "Studio", state: "pending" }],
        }),
      }),
      "approval",
      true,
    ],
  ] as const)("%s", (_name, given, kind, actionable) => {
    const state = chromeRowState(given);
    expect(state.kind).toBe(kind);
    expect(state.actionable).toBe(actionable);
  });

  it("checks the window's access before any action is offered", () => {
    // Not allowed wins over everything the status would say.
    expect(
      chromeRowState(input({ allowed: false, status: status({ profiles: [work] }) })).kind,
    ).toBe("not-allowed");
  });

  it("goes back to waiting once a new code is handed out after a paired profile went quiet", () => {
    expect(chromeRowState(input({ status: status({ paired: true }), codeHandedOut: true })).kind).toBe(
      "waiting",
    );
  });

  it("names paired profiles and flags old, hand-loaded and unnamed ones", () => {
    const state = chromeRowState(
      input({
        status: status({
          profiles: [
            work,
            { id: "p2", label: "Chrome (2)", extensionVersion: "1.3.9", fromStore: false },
            { id: "p3", label: "Chrome", extensionVersion: "1.4.0" },
          ],
        }),
      }),
    );
    expect(state.paired).toEqual(["Work", "Chrome (2)", "Chrome"]);
    expect(state.outdated).toEqual(["Chrome (2)"]);
    expect(state.notFromStore).toEqual(["Chrome (2)"]);
    expect(state.unnamed).toEqual(["Chrome (2)", "Chrome"]);
  });

  it("an allowed or declined machine waits for nothing", () => {
    const state = chromeRowState(
      input({
        status: status({
          profiles: [work],
          peers: [
            { id: "g1", machine: "Studio", state: "allowed" },
            { id: "g2", machine: "Mini", state: "declined" },
          ],
        }),
      }),
    );
    expect(state.kind).toBe("paired");
    expect(state.asking).toBeNull();
  });
});

describe("versionOlder", () => {
  it.each([
    ["1.3.9", "1.4.0", true],
    ["1.4.0", "1.4.0", false],
    ["1.4", "1.4.0", false],
    ["1.10.0", "1.9.9", false],
    ["0.9", "1.0", true],
    ["dev", "1.0", false],
  ] as const)("%s older than %s: %s", (a, b, older) => {
    expect(versionOlder(a, b)).toBe(older);
  });
});

it.each([
  ["Chrome", true],
  ["Chrome (2)", true],
  ["Chrome work", false],
  ["Work", false],
] as const)("isDefaultProfileName(%s) is %s", (name, result) => {
  expect(isDefaultProfileName(name)).toBe(result);
});
