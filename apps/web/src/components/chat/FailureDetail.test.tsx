import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { FailureDetail } from "./FailureDetail";

describe("failure detail display", () => {
  it("formats embedded reset timestamps without changing the provider message", () => {
    const message = "Next observed reset: 2026-10-18T03:58:37.000Z. Select an eligible profile.";
    const markup = renderToStaticMarkup(
      <FailureDetail message={message} timestampFormat="24-hour" />,
    );
    expect(markup).not.toContain("2026-10-18T03:58:37.000Z");
    expect(markup).toContain("2026");
    expect(markup).toContain("Select an eligible profile.");
    expect(message).toContain("2026-10-18T03:58:37.000Z");
  });
});
