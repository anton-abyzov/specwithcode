/** Bring back on the target (1267 AC-08): only threads that came from the caller go back. */
import { describe, expect, it } from "@effect/vitest";

import { returnable } from "./awayReturnRoute.ts";

describe("returnable", () => {
  it("hands back only the caller's continuations and says why the rest stay", () => {
    const result = returnable(
      [
        { id: "from-m4", sourceEnvironmentId: "env-m4", found: true },
        { id: "from-other", sourceEnvironmentId: "env-other", found: true },
        { id: "gone", sourceEnvironmentId: null, found: false },
      ],
      "env-m4",
    );
    expect(result.ok).toEqual(["from-m4"]);
    expect(result.refused.map((entry) => [entry.threadId, entry.outcome, entry.detail])).toEqual([
      ["from-other", "skipped", "That thread did not come here from your machine, so it stays."],
      ["gone", "skipped", "That thread is not on this machine any more."],
    ]);
  });
});
