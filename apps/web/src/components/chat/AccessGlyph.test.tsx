import type { RuntimeMode } from "@specweave-studio/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AccessGlyph, ReadOnlyAccessGlyph } from "./AccessGlyph";
import { MaskedFieldGlyph } from "./MaskedFieldGlyph";
import { runtimeModeConfig } from "./runtimeModeConfig";

const lit = (markup: string) => markup.match(/data-filled="true"/g)?.length ?? 0;

describe("AccessGlyph", () => {
  it("draws four dial segments and a hub on the 16px grid in currentColor", () => {
    const markup = renderToStaticMarkup(<AccessGlyph steps={2} className="size-4" />);
    expect(markup).toContain('viewBox="0 0 16 16"');
    expect(markup.match(/<path/g)).toHaveLength(4);
    expect(markup.match(/<circle/g)).toHaveLength(1);
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('aria-hidden="true"');
    expect(lit(markup)).toBe(2);
  });

  it("fills one more segment per access mode, from Supervised to Full access", () => {
    const steps = (mode: RuntimeMode) =>
      lit(renderToStaticMarkup(createElement(runtimeModeConfig[mode].icon)));
    expect(
      (["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map(steps),
    ).toEqual([1, 2, 3, 4]);
    expect(lit(renderToStaticMarkup(<ReadOnlyAccessGlyph />))).toBe(0);
  });
});

describe("MaskedFieldGlyph", () => {
  it("draws a field with three hidden characters in currentColor", () => {
    const markup = renderToStaticMarkup(<MaskedFieldGlyph className="size-4" />);
    expect(markup).toContain('viewBox="0 0 16 16"');
    expect(markup.match(/<rect/g)).toHaveLength(1);
    expect(markup.match(/<circle/g)).toHaveLength(3);
    expect(markup).toContain("currentColor");
    expect(markup).toContain("data-masked-field-glyph");
  });
});
