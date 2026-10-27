import { describe, expect, it, vi } from "vite-plus/test";
import { fallbackChain, fallbackStatusHeader } from "./fallbackStatus";

const opus = { provider: "Claude Code", model: "Opus 5.5", full: "Claude Code · Opus 5.5" };
const astra = { provider: "Codex", model: "GPT-6-Astra", full: "Codex · GPT-6-Astra" };
const sol = { provider: "Codex", model: "GPT-6.1-Sol", full: "Codex · GPT-6.1-Sol" };

const header = (over: Partial<Parameters<typeof fallbackStatusHeader>[0]> = {}) =>
  fallbackStatusHeader({
    pick: opus,
    pickModel: "Opus 5.5",
    running: astra,
    launched: false,
    hasRoom: false,
    resetLabel: "4:30 PM",
    onBack: vi.fn(),
    ...over,
  });

describe("fallbackStatusHeader", () => {
  it("names what runs now, the pick and why, and how it returns", () => {
    const status = header();
    expect(status.now).toBe("GPT-6-Astra · Codex");
    expect(status.pick).toEqual({ label: "Opus 5.5 · Claude Code", why: "Hit its usage limit." });
    expect(status.returns).toEqual({
      mode: "auto",
      text: "Goes back on its own after it resets at 4:30 PM.",
    });
    expect(status.back).toMatchObject({
      label: "Return to Opus 5.5 now",
      disabledReason: "Available at 4:30 PM",
    });
    expect(status.detail).toBe(
      "Opus 5.5 hit its usage limit. Goes back on its own after it resets at 4:30 PM.",
    );
  });

  it("says a launch stand-in only returns by hand", () => {
    const status = header({ launched: true, hasRoom: true });
    expect(status.pick?.why).toBe("Had no room when this thread started.");
    expect(status.returns).toEqual({
      mode: "manual",
      text: "Has room now. It does not switch back on its own.",
    });
    expect(status.back).toMatchObject({ label: "Return to Opus 5.5", disabledReason: null });
  });

  it("lets a person try the way back when room is unknown", () => {
    const status = header({ roomUnknown: "stale", resetLabel: null });
    expect(status.returns?.text).toBe(
      "Goes back on its own once a fresh usage reading shows room.",
    );
    expect(status.back?.disabledReason).toBeNull();
    expect(header({ roomUnknown: "unreported", resetLabel: null }).returns).toEqual({
      mode: "manual",
      text: "It reports no usage, so it goes back only by hand.",
    });
    // Room proven by the coordinator still needs a reading or a reset for the server to return.
    const proven = header({ hasRoom: true, pickReportsNoUsage: true, resetLabel: null });
    expect(proven.returns?.mode).toBe("manual");
    expect(proven.back?.label).toBe("Return to Opus 5.5");
  });
});

describe("fallbackStatusHeader after a usage pre-switch", () => {
  it("says the thread moved before its limit and goes back once below the switch line", () => {
    const status = header({ preswitched: true, resetLabel: null, canPickBack: true });
    expect(status.pick).toEqual({
      label: "Opus 5.5 · Claude Code",
      why: "Neared its usage limit.",
    });
    expect(status.returns).toEqual({
      mode: "auto",
      text: "Goes back on its own once it has room.",
    });
    expect(status.detail).toBe(
      "Opus 5.5 neared its usage limit. The idle thread goes back on its own once it has room.",
    );
    // Above the switch line the pick still takes a turn chosen by hand.
    expect(status.back?.disabledReason).toBeNull();
  });

  it("names why a blocked pre-switch stays on the fallback", () => {
    const status = header({ preswitched: true, hasRoom: true, returnBlock: "excluded" });
    expect(status.returns).toEqual({
      mode: "manual",
      text: "It stays on the fallback: the original model is excluded from automatic moves.",
    });
    expect(status.back?.label).toBe("Return to Opus 5.5");
  });
});

describe("fallbackChain", () => {
  const pick = { instanceId: "claude", model: "claude-opus-5-5", label: opus };
  const running = { instanceId: "codex", model: "gpt-6-astra", label: astra };

  it("puts the pick first and marks the running step in the user's order", () => {
    const chain = fallbackChain({
      pick,
      running,
      order: [
        {
          instanceId: "codex",
          model: "gpt-6.1-sol",
          label: sol,
          unavailable: "full",
          resetLabel: "5 PM",
        },
        { instanceId: "codex", model: "gpt-6-astra", label: astra, unavailable: "current" },
      ],
    });
    expect(chain.map((entry) => [entry.label, entry.role, entry.position, entry.note])).toEqual([
      ["Opus 5.5 · Claude Code", "pick", null, null],
      ["GPT-6.1-Sol · Codex", null, 1, "full until 5 PM"],
      ["GPT-6-Astra · Codex", "now", 2, null],
    ]);
  });

  it("skips the pick inside the order and adds a running model outside it", () => {
    const chain = fallbackChain({
      pick,
      running: { ...running, model: "gpt-6-astra[1m]" },
      order: [
        { instanceId: "claude", model: "claude-opus-5-5", label: opus, unavailable: "limited" },
        { instanceId: "codex", model: "gpt-6.1-sol", label: sol, unavailable: null },
      ],
    });
    expect(chain.map((entry) => [entry.role, entry.position, entry.note])).toEqual([
      ["pick", null, null],
      [null, 1, null],
      ["now", null, "not in your order"],
    ]);
  });
});
