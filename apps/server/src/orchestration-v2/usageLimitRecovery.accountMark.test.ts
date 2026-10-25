import { assert, describe, it } from "@effect/vitest";

import { accountChangeMark, accountChangeOf } from "./usageLimitRecovery.ts";

describe("accountChangeOf", () => {
  const thread = "thread:delegated-task:command%3Amcp%3Aabc";
  const run = "run:thread:thread%3Adelegated-task%3Acommand%253Amcp%253Aabc:ordinal:4";

  it("reads the mark right after the stop's reset", () => {
    const id = `limit-resume:${thread}:${run}:1761300000000${accountChangeMark(1761290000000)}:req-1`;
    assert.strictEqual(accountChangeOf(id), 1761290000000);
  });

  it("ignores a mark carried inside a reused refused id", () => {
    const refused = `limit-resume:${thread}:${run}:1761300000000${accountChangeMark(1761290000000)}:req-1`;
    const later = `limit-resume:${thread}:${run}:1761300000000:${refused}`;
    assert.isNull(accountChangeOf(later));
  });

  it("is null for an ordinary resume", () => {
    assert.isNull(accountChangeOf(`limit-resume:${thread}:${run}:1761300000000:req-1`));
    assert.isNull(accountChangeOf(`limit-resume:${thread}:${run}:NaN:legacy`));
  });
});
