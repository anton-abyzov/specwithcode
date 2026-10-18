import { describe, expect, it } from "@effect/vitest";

import { formatOpenedRunningServer } from "./server.ts";

describe("specwithcode when SpecWithCode already runs here", () => {
  it("says it opened the running server instead of printing an error", () => {
    const opened = formatOpenedRunningServer({ origin: "http://127.0.0.1:8319", opened: true });
    expect(opened).toBe(
      "SpecWithCode is already running on this machine (http://127.0.0.1:8319). Opened it in your browser.",
    );
    expect(opened).not.toMatch(/error|stop it/i);
  });

  it("points to the app or `specwithcode pair` when no browser opens", () => {
    const shown = formatOpenedRunningServer({ origin: "http://127.0.0.1:8319", opened: false });
    expect(shown).toContain("http://127.0.0.1:8319");
    expect(shown).toContain("specwithcode pair");
    expect(shown).not.toMatch(/error|stop it/i);
  });
});
