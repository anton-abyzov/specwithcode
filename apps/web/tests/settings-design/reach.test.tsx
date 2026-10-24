import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  SettingsReachLabel,
  scrollToSettingsTarget,
} from "../../src/components/settings/settingsLayout";
afterEach(() => vi.unstubAllGlobals());
describe("settings reach and disclosure search", () => {
  it("keeps one vocabulary for each reach, including an escaped machine name", () => {
    for (const [reach, label] of [
      [{ kind: "device" }, "This device"],
      [{ kind: "all" }, "All connected machines"],
      [{ kind: "project" }, "This project"],
      [{ kind: "machine", name: "M4 & work" }, "This machine: M4 &amp; work"],
    ] as const)
      expect(renderToStaticMarkup(<SettingsReachLabel reach={reach} />)).toContain(label);
  });
  it("leaves an unknown machine unlabeled", () => {
    expect(renderToStaticMarkup(<SettingsReachLabel reach={{ kind: "machine" }} />)).toBe("");
    expect(
      renderToStaticMarkup(<SettingsReachLabel reach={{ kind: "machine", name: " " }} />),
    ).toBe("");
  });
  it("opens every enclosing disclosure before scrolling to a nested field", () => {
    const outer = { tagName: "DETAILS", open: false, parentElement: null };
    const inner = { tagName: "DETAILS", open: false, parentElement: outer };
    const focus = vi.fn();
    const target = {
      tagName: "INPUT",
      parentElement: inner,
      focus,
      scrollIntoView: vi.fn(() => {
        expect(inner.open).toBe(true);
        expect(outer.open).toBe(true);
      }),
      classList: { remove: vi.fn() },
    };
    vi.stubGlobal("document", { getElementById: () => target });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(scrollToSettingsTarget("nested-path")).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
