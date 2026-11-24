// @effect-diagnostics anyUnknownInErrorContext:off -- the secret store and CloudLink are loosely typed fakes.
/**
 * The Connect account as the peer route and the sync loop read it (1448
 * T-14): they run below `CloudLink` in the server's layers, so the reader
 * falls back to the stored link, and a failed read is `unknown`, never "not
 * linked".
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CloudLink from "./CloudLink.ts";
import { CLOUD_LINKED_USER_ID } from "./config.ts";
import { cloudUserIdOf, connectAccountReader } from "./connectAccount.ts";

const secrets = (get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, unknown>) =>
  Effect.provideService(ServerSecretStore.ServerSecretStore, { get } as any);

const read = Effect.flatten(connectAccountReader);

describe("connectAccountReader", () => {
  it.effect("reads the stored link when CloudLink is not in this context", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const account = yield* read.pipe(
        secrets((name) => {
          asked.push(name);
          return Effect.succeed(Option.some(new TextEncoder().encode(" user_owner_1\n")));
        }),
      );
      assert.deepStrictEqual(account, { status: "linked", cloudUserId: "user_owner_1" });
      assert.deepStrictEqual(asked, [CLOUD_LINKED_USER_ID]);
      assert.strictEqual(cloudUserIdOf(account), "user_owner_1");
    }),
  );

  it.effect("no stored link, or an empty one, is not linked", () =>
    Effect.gen(function* () {
      const none = yield* read.pipe(secrets(() => Effect.succeed(Option.none())));
      const empty = yield* read.pipe(
        secrets(() => Effect.succeed(Option.some(new TextEncoder().encode("  ")))),
      );
      assert.deepStrictEqual(none, { status: "not_linked" });
      assert.deepStrictEqual(empty, { status: "not_linked" });
      assert.isNull(cloudUserIdOf(none));
    }),
  );

  it.effect("a failed read, or no store at all, is unknown", () =>
    Effect.gen(function* () {
      const failed = yield* read.pipe(secrets(() => Effect.fail("locked")));
      const missing = yield* read;
      assert.deepStrictEqual(failed, { status: "unknown" });
      assert.deepStrictEqual(missing, { status: "unknown" });
      assert.isNull(cloudUserIdOf(failed));
    }),
  );

  it.effect("prefers CloudLink when the context has it", () =>
    Effect.gen(function* () {
      const linked = yield* read.pipe(
        Effect.provideService(CloudLink.CloudLink, {
          linkState: () => Effect.succeed({ cloudUserId: "user_owner_1" }),
        } as any),
        secrets(() => Effect.die("not read")),
      );
      const failing = yield* read.pipe(
        Effect.provideService(CloudLink.CloudLink, {
          linkState: () => Effect.fail("offline"),
        } as any),
      );
      assert.deepStrictEqual(linked, { status: "linked", cloudUserId: "user_owner_1" });
      assert.deepStrictEqual(failing, { status: "unknown" });
    }),
  );
});
