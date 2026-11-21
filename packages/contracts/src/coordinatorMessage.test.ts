import { describe, expect, it } from "@effect/vitest";

import { COORDINATOR_MESSAGE_REPORT_PATH, isWebUrl } from "./coordinatorMessage.ts";

describe("COORDINATOR_MESSAGE_REPORT_PATH", () => {
  it.each([
    ".specweave/increments/1427-test/reports/m5.md",
    ".specweave/increments/1427-test/reports/run/one/log.txt",
    ".specweave/increments/1427-test/reports/page.HTML",
  ])("accepts the report %s", (path) => {
    expect(COORDINATOR_MESSAGE_REPORT_PATH.test(path)).toBe(true);
  });

  it.each([
    ".specweave/increments/../reports/m5.md",
    ".specweave/increments/./reports/m5.md",
    ".specweave/increments/1427-test/reports/../../secrets/m5.md",
    ".specweave/increments/1427-test/reports/./m5.md",
    ".specweave/increments/1427-test/reports/a\\..\\m5.md",
    ".specweave/increments/1427\\x/reports/m5.md",
    ".specweave/increments/1427-test/m5.md",
    ".specweave/increments/1427-test/reports/m5.sh",
    "/.specweave/increments/1427-test/reports/m5.md",
  ])("refuses %s", (path) => {
    expect(COORDINATOR_MESSAGE_REPORT_PATH.test(path)).toBe(false);
  });
});

describe("isWebUrl", () => {
  it.each(["https://github.com/o/r/pull/1", "http://example.com/x"])("opens %s", (url) => {
    expect(isWebUrl(url)).toBe(true);
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "/relative", "nope"])(
    "refuses %s",
    (url) => {
      expect(isWebUrl(url)).toBe(false);
    },
  );
});
