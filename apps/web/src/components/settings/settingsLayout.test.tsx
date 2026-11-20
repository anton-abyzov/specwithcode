import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PolicyTooltip,
  scrollToSettingsTarget,
  SettingsRow,
  SettingsUnavailableGroup,
} from "./settingsLayout";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unavailable settings", () => {
  it("groups disabled controls under one reason", () => {
    const markup = renderToStaticMarkup(
      <SettingsUnavailableGroup message="Only available in the desktop app.">
        <SettingsRow title="Window capture" description="Capture a window." />
      </SettingsUnavailableGroup>,
    );

    expect(markup).toContain("Only available in the desktop app.");
    expect(markup).toContain("border-border/60");
    expect(markup).toContain("[&amp;_h3]:opacity-(--disabled-opacity)");
  });
});

describe("title info", () => {
  it("draws the note's button beside the title, named for its setting", () => {
    const markup = renderToStaticMarkup(
      <SettingsRow
        title="Review finished features automatically"
        description="A model from a different family reviews the work."
        titleInfo={
          <PolicyTooltip label="How much longer work takes with Review finished features automatically">
            Can make work take much longer to finish.
          </PolicyTooltip>
        }
      />,
    );
    const title = markup.indexOf("Review finished features automatically</h3>");
    const button = markup.indexOf(
      'aria-label="How much longer work takes with Review finished features automatically"',
    );
    expect(title).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(title);
    expect(markup).not.toContain('aria-label="Background policy details"');
  });

  it("keeps the background policy name when no label is given", () => {
    expect(renderToStaticMarkup(<PolicyTooltip>Shared policy.</PolicyTooltip>)).toContain(
      'aria-label="Background policy details"',
    );
  });
});

describe("settings search targets", () => {
  it("scrolls directly to a section header and restarts the destination pulse", () => {
    const sectionScrollIntoView = vi.fn();
    const headerScrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const addEventListener = vi.fn();
    const target = {
      tagName: "SECTION",
      firstElementChild: { scrollIntoView: headerScrollIntoView },
      scrollIntoView: sectionScrollIntoView,
      focus,
      classList: { remove, add },
      addEventListener,
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    expect(scrollToSettingsTarget("providers")).toBe(true);
    expect(headerScrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(sectionScrollIntoView).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(addEventListener).toHaveBeenCalledWith("blur", expect.any(Function), { once: true });
  });

  it("does not animate the destination when reduced motion is requested", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const target = {
      tagName: "DIV",
      firstElementChild: null,
      scrollIntoView,
      focus,
      classList: { remove, add },
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })),
    });

    expect(scrollToSettingsTarget("word-wrap")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).not.toHaveBeenCalled();
  });

  it("leaves not-yet-mounted destinations to their mount lifecycle", () => {
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => null),
    });

    expect(scrollToSettingsTarget("archive")).toBe(false);
  });
});
