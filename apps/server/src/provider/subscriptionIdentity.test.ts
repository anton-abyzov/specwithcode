import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { ServerProvider } from "@specweave-studio/contracts";

import {
  claudeSubscriptionKey,
  claudeSubscriptionReadOf,
  identitiesDiffer,
  makeSubscriptionMemory,
  nextIdentity,
  subscriptionChangedSince,
  subscriptionKeyOf,
} from "./subscriptionIdentity.ts";

describe("claudeSubscriptionKey", () => {
  const base = { email: "Me@Example.com", organization: "Personal", subscriptionType: "max" };

  it("is opaque and the same for the same sign-in", () => {
    const key = claudeSubscriptionKey(base);
    assert.match(key ?? "", /^claude:sha256:[a-f0-9]{64}$/);
    assert.strictEqual(claudeSubscriptionKey({ ...base, email: "me@example.com" }), key);
    assert.notInclude(key ?? "", "example");
  });

  it("differs for another organization or plan on the same email", () => {
    const key = claudeSubscriptionKey(base);
    assert.notStrictEqual(claudeSubscriptionKey({ ...base, organization: "Team" }), key);
    assert.notStrictEqual(claudeSubscriptionKey({ ...base, subscriptionType: "pro" }), key);
  });

  it("names no subscription without a plan or an email", () => {
    assert.isUndefined(claudeSubscriptionKey({ ...base, subscriptionType: undefined }));
    assert.isUndefined(claudeSubscriptionKey({ ...base, email: " " }));
  });
});

describe("subscription identity", () => {
  it("reads Codex's account pool as its key", () => {
    const pool = `codex:sha256:${"c".repeat(64)}`;
    assert.strictEqual(
      subscriptionKeyOf({ checkedAt: "2026-10-25T05:00:00.000Z", windows: [], quotaPoolId: pool }),
      pool,
    );
  });

  it("decides by key when both are known and by email otherwise", () => {
    assert.isTrue(identitiesDiffer({ key: "k1", email: "e" }, { key: "k2", email: "e" }));
    assert.isFalse(identitiesDiffer({ key: "k1", email: "e1" }, { key: "k1", email: "e2" }));
    assert.isTrue(identitiesDiffer({ key: "k1", email: "e1" }, { email: "e2" }));
    assert.isFalse(identitiesDiffer({ key: "k1" }, { email: "e2" }));
  });

  it("keeps a known key through a read of the same person that could not name it", () => {
    assert.deepStrictEqual(nextIdentity({ key: "k1", email: "e" }, { email: "e" }), {
      key: "k1",
      email: "e",
    });
    assert.deepStrictEqual(nextIdentity({ key: "k1", email: "e" }, undefined), {
      key: "k1",
      email: "e",
    });
    assert.deepStrictEqual(nextIdentity({ key: "k1", email: "e" }, { email: "f" }), {
      email: "f",
    });
  });
});

describe("claudeSubscriptionReadOf", () => {
  const subscriptionKey = `claude:sha256:${"a".repeat(64)}`;
  const snapshot = (auth: object, usageLimits?: object) =>
    ({ auth, ...(usageLimits ? { usageLimits } : {}) }) as unknown as ServerProvider;
  const personal = snapshot(
    { status: "authenticated", type: "pro", email: "me@x.dev" },
    { checkedAt: "2026-11-19T10:00:00.000Z", windows: [], subscriptionKey },
  );
  // The Console read keeps the subscription's windows (and key) as history.
  const consoleRead = (email: string) =>
    snapshot(
      {
        status: "authenticated",
        type: "apiKey",
        apiKeyBilling: true,
        email,
        label: "Claude Console (API Usage Billing)",
      },
      { checkedAt: "2026-11-19T10:05:00.000Z", windows: [], subscriptionKey },
    );

  it("tells a Console sign-in from the subscription it outranks, both ways", () => {
    const opened = claudeSubscriptionReadOf(personal);
    const console = claudeSubscriptionReadOf(consoleRead("api@x.dev"));
    assert.strictEqual(opened.key, subscriptionKey);
    assert.match(console.key ?? "", /^claude-api:sha256:[a-f0-9]{64}$/);
    assert.notInclude(console.key ?? "", "x.dev");
    assert.isTrue(subscriptionChangedSince(opened, 0, console));
    assert.isTrue(subscriptionChangedSince(console, 0, opened));
  });

  it("tells two Console accounts apart and keeps one the same", () => {
    const one = claudeSubscriptionReadOf(consoleRead("api@x.dev"));
    assert.isFalse(
      subscriptionChangedSince(one, 0, claudeSubscriptionReadOf(consoleRead("API@x.dev"))),
    );
    assert.isTrue(
      subscriptionChangedSince(one, 0, claudeSubscriptionReadOf(consoleRead("other@x.dev"))),
    );
  });

  it("names nothing for a read that is not signed in, so no process is replaced", () => {
    const failed = claudeSubscriptionReadOf(snapshot({ status: "unknown" }));
    assert.isUndefined(failed.key);
    assert.isFalse(subscriptionChangedSince(claudeSubscriptionReadOf(personal), 0, failed));
  });
});

it.layer(NodeServices.layer)("makeSubscriptionMemory", (it) => {
  it.effect("round-trips the remembered subscription and stores no email", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-subscription-" });
      const memory = makeSubscriptionMemory({
        cacheDir,
        instanceId: "claudeAgent",
        fileSystem: fs,
        path,
      });
      assert.isUndefined(yield* memory.load);
      yield* memory.save({
        identity: { key: `claude:sha256:${"a".repeat(64)}`, email: "f".repeat(64) },
        changedAt: "2026-10-25T05:10:00.000Z",
      });
      assert.deepStrictEqual(yield* memory.load, {
        identity: { key: `claude:sha256:${"a".repeat(64)}`, email: "f".repeat(64) },
        changedAt: "2026-10-25T05:10:00.000Z",
      });
      const stored = yield* fs.readFileString(path.join(cacheDir, "claudeAgent.account.json"));
      assert.notInclude(stored, "@");
    }),
  );

  it.effect("falls back to the provider status cache's sign-in after an upgrade", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-subscription-" });
      yield* fs.writeFileString(
        path.join(cacheDir, "claudeAgent.json"),
        JSON.stringify({ auth: { status: "authenticated", email: "Me@Example.com" } }),
      );
      yield* fs.writeFileString(
        path.join(cacheDir, "codex.json"),
        JSON.stringify({ auth: { status: "authenticated", email: "x@y.z", apiKeyBilling: true } }),
      );
      const claude = makeSubscriptionMemory({
        cacheDir,
        instanceId: "claudeAgent",
        fileSystem: fs,
        path,
      });
      const codex = makeSubscriptionMemory({ cacheDir, instanceId: "codex", fileSystem: fs, path });
      const pool = `codex:sha256:${"d".repeat(64)}`;
      yield* fs.writeFileString(
        path.join(cacheDir, "codex-work.json"),
        JSON.stringify({
          auth: { status: "authenticated", email: "x@y.z" },
          usageLimits: { quotaPoolId: pool },
        }),
      );
      const codexWork = makeSubscriptionMemory({
        cacheDir,
        instanceId: "codex-work",
        fileSystem: fs,
        path,
      });
      // Codex's cached pool names the workspace, so a same-email switch is seen.
      assert.strictEqual((yield* codexWork.load)?.identity.key, pool);
      const loaded = yield* claude.load;
      assert.match(loaded?.identity.email ?? "", /^[a-f0-9]{64}$/);
      assert.isUndefined(loaded?.changedAt);
      assert.isUndefined(yield* codex.load);
    }),
  );
});
