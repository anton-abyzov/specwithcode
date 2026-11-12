import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import {
  claudeLoginIdentity,
  codexLoginIdentity,
  loginFileMark,
  museLoginIdentity,
  watchLoginChanges,
} from "./loginWatch.ts";

function claudeConfig(account: { accountUuid: string; emailAddress: string } | null, startups = 1) {
  return JSON.stringify({
    numStartups: startups,
    ...(account ? { oauthAccount: { ...account, organizationUuid: "org-1" } } : {}),
  });
}

function jwt(claims: object): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function codexAuth(accountId: string, email: string, accessToken: string) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email }),
      access_token: accessToken,
      refresh_token: "r",
      account_id: accountId,
    },
    last_refresh: DateTime.formatIso(DateTime.makeUnsafe(0)),
  });
}

describe("login identities", () => {
  it("ignores Claude bookkeeping writes and sees a different account", () => {
    const first = claudeLoginIdentity(
      claudeConfig({ accountUuid: "a", emailAddress: "A@x.dev" }, 1),
    );
    const bookkeeping = claudeLoginIdentity(
      claudeConfig({ accountUuid: "a", emailAddress: "a@x.dev" }, 2),
    );
    const other = claudeLoginIdentity(claudeConfig({ accountUuid: "b", emailAddress: "b@x.dev" }));
    const signedOut = claudeLoginIdentity(claudeConfig(null));
    assert.strictEqual(first, bookkeeping);
    assert.notStrictEqual(first, other);
    assert.notStrictEqual(first, signedOut);
    assert.strictEqual(claudeLoginIdentity("{not json"), undefined);
  });

  it("ignores Codex token rotation and sees a different account", () => {
    const first = codexLoginIdentity(codexAuth("acct-1", "a@x.dev", "t1"));
    const rotated = codexLoginIdentity(codexAuth("acct-1", "a@x.dev", "t2"));
    const other = codexLoginIdentity(codexAuth("acct-2", "b@x.dev", "t3"));
    const sameWorkspaceOtherPerson = codexLoginIdentity(codexAuth("acct-1", "b@x.dev", "t4"));
    assert.strictEqual(first, rotated);
    assert.notStrictEqual(first, other);
    assert.notStrictEqual(first, sameWorkspaceOtherPerson);
  });
});

function museAuth(email: string | null, subscribed = true) {
  return JSON.stringify({
    schema_version: 1,
    providers: email
      ? {
          meta: {
            mechanism: "oauth",
            storage: "keychain",
            subs_active: subscribed,
            user_full_name: "A Person",
            user_email: email,
          },
        }
      : {},
  });
}

describe("the Muse Code account", () => {
  it("is told apart by who is signed in, not by how the file is written", () => {
    const first = museLoginIdentity(museAuth("A@x.dev"));
    assert.strictEqual(first, museLoginIdentity(museAuth("a@x.dev")));
    assert.notStrictEqual(first, museLoginIdentity(museAuth("b@x.dev")));
    assert.notStrictEqual(first, museLoginIdentity(museAuth(null)));
    assert.notStrictEqual(first, museLoginIdentity(museAuth("a@x.dev", false)));
    assert.strictEqual(museLoginIdentity("{not json"), undefined);
  });
});

describe("loginFileMark", () => {
  it.live("changes with any rewrite, also by the same account, and never fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const filePath = path.join(dir, "auth.json");
        assert.strictEqual(yield* loginFileMark(filePath), "none");

        yield* fs.writeFileString(filePath, codexAuth("acct-1", "a@x.dev", "t1"));
        const first = yield* loginFileMark(filePath);
        assert.strictEqual(yield* loginFileMark(filePath), first);
        // The same account signs in again: new tokens, same identity.
        yield* fs.writeFileString(filePath, codexAuth("acct-1", "a@x.dev", "t2"));
        const again = yield* loginFileMark(filePath);
        assert.notStrictEqual(again, first);
        // A short hash and a length: no part of the file can be read from the mark.
        assert.match(again, /^\d+:[0-9a-f]{1,14}$/);

        yield* fs.remove(filePath);
        assert.strictEqual(yield* loginFileMark(filePath), "none");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("watchLoginChanges", () => {
  it.live("refreshes once per account switch, not per rewrite", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const filePath = path.join(dir, ".claude.json");
        yield* fs.writeFileString(
          filePath,
          claudeConfig({ accountUuid: "a", emailAddress: "a@x.dev" }),
        );
        const changes = yield* Queue.unbounded<void>();
        yield* watchLoginChanges({
          filePath,
          readIdentity: claudeLoginIdentity,
          onChange: Queue.offer(changes, undefined).pipe(Effect.asVoid),
          debounce: "30 millis",
        });
        yield* Effect.sleep("100 millis");

        // The CLI rewrites the file all the time for the same account.
        yield* fs.writeFileString(
          filePath,
          claudeConfig({ accountUuid: "a", emailAddress: "a@x.dev" }, 7),
        );
        yield* fs.writeFileString(path.join(dir, "unrelated.json"), "{}");
        yield* Effect.sleep("200 millis");
        assert.strictEqual(yield* Queue.size(changes), 0);

        // `/login` replaces the file with another account.
        const staged = path.join(dir, ".claude.json.tmp");
        yield* fs.writeFileString(
          staged,
          claudeConfig({ accountUuid: "b", emailAddress: "b@x.dev" }),
        );
        yield* fs.rename(staged, filePath);
        yield* Queue.take(changes).pipe(Effect.timeout("3 seconds"));
        yield* Effect.sleep("200 millis");
        assert.strictEqual(yield* Queue.size(changes), 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("leaves a missing directory to the periodic probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        yield* watchLoginChanges({
          filePath: path.join(dir, "missing", "auth.json"),
          readIdentity: codexLoginIdentity,
          onChange: Effect.die("must not run"),
        });
        yield* Effect.sleep("50 millis");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
