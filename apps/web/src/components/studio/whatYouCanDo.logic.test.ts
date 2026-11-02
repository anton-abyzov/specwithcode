import { describe, expect, it } from "vite-plus/test";

import { providerCanRunWork, showWhatYouCanDo, whatYouCanDoItems } from "./whatYouCanDo.logic";

const none = {
  agentReady: false,
  hasProject: false,
  hasSession: false,
  hasRoutine: false,
  hasOtherMachine: false,
};
const all = {
  agentReady: true,
  hasProject: true,
  hasSession: true,
  hasRoutine: true,
  hasOtherMachine: true,
};

describe("whatYouCanDoItems", () => {
  it("ticks each item from its own state only", () => {
    expect(whatYouCanDoItems(none).filter((item) => item.done)).toEqual([]);
    expect(
      whatYouCanDoItems({ ...none, hasRoutine: true })
        .filter((item) => item.done)
        .map((item) => item.id),
    ).toEqual(["routine"]);
  });

  it("stays to five items", () => {
    expect(whatYouCanDoItems(none)).toHaveLength(5);
  });
});

describe("showWhatYouCanDo", () => {
  const items = whatYouCanDoItems(none);

  it("shows open items once the workspace is known", () => {
    expect(showWhatYouCanDo({ dismissed: false, known: true, items })).toBe(true);
  });

  it("stays hidden until the workspace is known, so nothing ticks late", () => {
    expect(showWhatYouCanDo({ dismissed: false, known: false, items })).toBe(false);
  });

  it("stays hidden once dismissed", () => {
    expect(showWhatYouCanDo({ dismissed: true, known: true, items })).toBe(false);
  });

  it("goes away when everything is done", () => {
    expect(showWhatYouCanDo({ dismissed: false, known: true, items: whatYouCanDoItems(all) })).toBe(
      false,
    );
  });
});

describe("providerCanRunWork", () => {
  const provider = {
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    auth: { status: "authenticated" },
  } as const;

  it("counts a usable provider, and a warning as advisory", () => {
    expect(providerCanRunWork(provider)).toBe(true);
    expect(providerCanRunWork({ ...provider, status: "warning" })).toBe(true);
  });

  it("refuses a disabled one that still reports ready", () => {
    expect(providerCanRunWork({ ...provider, enabled: false })).toBe(false);
  });

  it("refuses one that is missing or signed out", () => {
    expect(providerCanRunWork({ ...provider, installed: false })).toBe(false);
    expect(providerCanRunWork({ ...provider, auth: { status: "unauthenticated" } })).toBe(false);
    expect(providerCanRunWork({ ...provider, status: "error" })).toBe(false);
  });
});
