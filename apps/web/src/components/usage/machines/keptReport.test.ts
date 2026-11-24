import { describe, expect, it } from "vite-plus/test";

import { keptCoversStart } from "./keptReport";

describe("keptCoversStart", () => {
  it("keeps an offline machine's report that ended yesterday for Past 7 days", () => {
    expect(keptCoversStart({ sinceDay: "2026-10-26", untilDay: "2026-11-23" }, "2026-11-18")).toBe(
      true,
    );
  });
  it("keeps a report covering a past custom range", () => {
    expect(keptCoversStart({ sinceDay: "2026-10-02", untilDay: "2026-10-31" }, "2026-10-26")).toBe(
      true,
    );
  });
  it("drops a report that starts after the shown days begin (a widened range)", () => {
    expect(keptCoversStart({ sinceDay: "2026-11-18", untilDay: "2026-11-24" }, "2026-10-26")).toBe(
      false,
    );
  });
  it("drops a report that ended before the shown days begin", () => {
    expect(keptCoversStart({ sinceDay: "2026-09-01", untilDay: "2026-09-30" }, "2026-11-18")).toBe(
      false,
    );
  });
});
