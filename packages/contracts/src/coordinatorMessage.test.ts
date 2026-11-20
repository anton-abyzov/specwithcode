import { describe, expect, it } from "@effect/vitest";

import { COORDINATOR_MESSAGE_REPORT_PATH } from "./coordinatorMessage.ts";

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
