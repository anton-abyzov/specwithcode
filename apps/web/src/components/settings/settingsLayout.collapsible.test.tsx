import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPACT_DESCRIPTION_MAX_LENGTH,
  descriptionGoesBehindInfo,
  SettingsCollapsibleSection,
} from "./settingsLayout";

describe("descriptionGoesBehindInfo", () => {
  const long = "x".repeat(COMPACT_DESCRIPTION_MAX_LENGTH + 1);

  it("keeps every description printed on a page that is not compact", () => {
    expect(descriptionGoesBehindInfo(long, false)).toBe(false);
  });

  it("prints a one-line description and hides a longer one on a compact page", () => {
    expect(descriptionGoesBehindInfo("x".repeat(COMPACT_DESCRIPTION_MAX_LENGTH), true)).toBe(false);
    expect(descriptionGoesBehindInfo(long, true)).toBe(true);
  });

  it("leaves a description that is not plain text alone", () => {
    expect(descriptionGoesBehindInfo({ rich: long }, true)).toBe(false);
  });
});

describe("SettingsCollapsibleSection", () => {
  it("rests closed with its rows still mounted for settings search", () => {
    const html = renderToStaticMarkup(
      <SettingsCollapsibleSection id="advanced-test" title="Advanced" count={3}>
        <div id="inner-row">row</div>
      </SettingsCollapsibleSection>,
    );
    expect(html).toContain('<details id="advanced-test"');
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('id="inner-row"');
    expect(html).toContain(">3<");
  });

  it("opens when asked to start open", () => {
    const html = renderToStaticMarkup(
      <SettingsCollapsibleSection id="open-test" title="Advanced" defaultOpen>
        <div>row</div>
      </SettingsCollapsibleSection>,
    );
    expect(html).toMatch(/<details[^>]* open/);
  });
});
