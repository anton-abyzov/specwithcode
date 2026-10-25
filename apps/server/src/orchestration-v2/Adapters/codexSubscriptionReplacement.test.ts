import { assert, describe, it } from "@effect/vitest";

import {
  CODEX_SUBSCRIPTION_CHANGED_REASON,
  codexSubscriptionReplacement,
} from "./CodexAdapterV2.ts";

const A = `codex:sha256:${"a".repeat(64)}`;
const B = `codex:sha256:${"b".repeat(64)}`;
const OPENED_AT = Date.parse("2026-10-25T06:00:00.000Z");

describe("codexSubscriptionReplacement", () => {
  it("replaces a process opened on a known subscription once another is read", () => {
    assert.strictEqual(
      codexSubscriptionReplacement({ key: A }, OPENED_AT, { key: B }),
      CODEX_SUBSCRIPTION_CHANGED_REASON,
    );
    assert.isNull(codexSubscriptionReplacement({ key: A }, OPENED_AT, { key: A }));
    // A read that names no subscription proves nothing.
    assert.isNull(codexSubscriptionReplacement({ key: A }, OPENED_AT, {}));
  });

  it("replaces a process opened before any read named it only after a change it started before", () => {
    // Right after a restart: the first read names the key; no change was seen.
    assert.isNull(codexSubscriptionReplacement({}, OPENED_AT, { key: A }));
    // A change stamped before the process started is the one it already runs on.
    assert.isNull(
      codexSubscriptionReplacement({}, OPENED_AT, {
        key: B,
        changedAt: "2026-10-25T05:00:00.000Z",
      }),
    );
    assert.strictEqual(
      codexSubscriptionReplacement({}, OPENED_AT, {
        key: B,
        changedAt: "2026-10-25T06:10:00.000Z",
      }),
      CODEX_SUBSCRIPTION_CHANGED_REASON,
    );
  });
});
