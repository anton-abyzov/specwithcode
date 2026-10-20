import { ProviderDriverKind } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThinkingMark } from "./ThinkingMark";

describe("ThinkingMark", () => {
  it("shows the thinking provider's mark, muted", () => {
    const markup = renderToStaticMarkup(
      <ThinkingMark provider={{ driver: ProviderDriverKind.make("claudeAgent") }} />,
    );
    expect(markup).toContain('data-thinking-mark="claudeAgent"');
    expect(markup).toContain("grayscale");
    expect(markup).toContain("<svg");
    expect(markup).not.toContain("thinking-mark-pulse");
  });

  it("falls back to the crafted dots when the provider is unknown", () => {
    const markup = renderToStaticMarkup(<ThinkingMark provider={undefined} />);
    expect(markup).toContain("data-thinking-dots-glyph");
    expect(markup.match(/<circle/g)).toHaveLength(3);
  });

  it("pulses only while streaming", () => {
    const streaming = renderToStaticMarkup(<ThinkingMark provider={undefined} pulse />);
    expect(streaming).toContain("thinking-mark-pulse");
    expect(streaming).toContain("data-thinking-pulse");
  });
});
