import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import {
  anthropicProfileDirectory,
  anthropicProfileMark,
  claudeLoginIdentity,
  codexLoginIdentity,
  loginFileMark,
  museLoginIdentity,
  readLoginIdentity,
  watchLoginChanges,
  watchMarkChanges,
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

        // A folder at that path is not a login file, and a huge file is not read.
        yield* fs.makeDirectory(filePath);
        assert.strictEqual(yield* loginFileMark(filePath), "none");
        yield* fs.remove(filePath, { recursive: true });
        yield* fs.writeFileString(filePath, "x".repeat(1_048_577));
        assert.strictEqual(yield* loginFileMark(filePath), "1048577:unread");
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

describe("Anthropic profile folder", () => {
  it.effect(
    "is ANTHROPIC_CONFIG_DIR, else XDG_CONFIG_HOME/anthropic, else ~/.config/anthropic",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        assert.strictEqual(
          yield* anthropicProfileDirectory({ ANTHROPIC_CONFIG_DIR: "/p", XDG_CONFIG_HOME: "/x" }),
          path.resolve("/p"),
        );
        assert.strictEqual(
          yield* anthropicProfileDirectory({ XDG_CONFIG_HOME: "/x", HOME: "/h" }),
          path.join("/x", "anthropic"),
        );
        assert.strictEqual(
          yield* anthropicProfileDirectory({ HOME: "/h" }),
          path.join("/h", ".config", "anthropic"),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("marks a Console sign-in, a switch and a sign-out without reading a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(yield* fs.makeTempDirectoryScoped(), "anthropic");
      assert.strictEqual(yield* anthropicProfileMark(dir), "none");

      yield* fs.makeDirectory(path.join(dir, "configs"), { recursive: true });
      const empty = yield* anthropicProfileMark(dir);
      assert.strictEqual(yield* anthropicProfileMark(dir), empty);

      yield* fs.writeFileString(path.join(dir, "configs", "default.json"), '{"org":"one"}');
      yield* fs.writeFileString(path.join(dir, "active_config"), "default");
      const signedIn = yield* anthropicProfileMark(dir);
      assert.notStrictEqual(signedIn, empty);
      // A short count and hash: no name, address or token can be read from it.
      assert.match(signedIn, /^\d+:[0-9a-f]{1,14}$/);

      yield* fs.writeFileString(path.join(dir, "configs", "work.json"), '{"org":"two"}');
      const switched = yield* anthropicProfileMark(dir);
      assert.notStrictEqual(switched, signedIn);

      yield* fs.remove(dir, { recursive: true });
      assert.strictEqual(yield* anthropicProfileMark(dir), "none");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("watchMarkChanges", () => {
  it.live("sees a switch in any watched folder, also when another folder is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const accountFile = path.join(home, ".claude.json");
        // Not there yet: a first Console sign-in creates it.
        const profiles = path.join(home, ".config", "anthropic");
        yield* fs.writeFileString(
          accountFile,
          claudeConfig({ accountUuid: "a", emailAddress: "a@x.dev" }),
        );
        const readMark = Effect.all([
          readLoginIdentity(accountFile, claudeLoginIdentity),
          anthropicProfileMark(profiles),
        ]).pipe(
          Effect.map((parts) => JSON.stringify(parts)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        const changes = yield* Queue.unbounded<void>();
        yield* watchMarkChanges({
          watches: [
            { directory: home, fileName: ".claude.json" },
            { directory: profiles },
            { directory: path.join(profiles, "configs") },
          ],
          readMark,
          onChange: Queue.offer(changes, undefined).pipe(Effect.asVoid),
          debounce: "30 millis",
        });
        yield* Effect.sleep("100 millis");

        // Bookkeeping for the same account and unrelated files in the home folder.
        yield* fs.writeFileString(
          accountFile,
          claudeConfig({ accountUuid: "a", emailAddress: "a@x.dev" }, 9),
        );
        yield* fs.writeFileString(path.join(home, ".zsh_history"), "ls");
        yield* Effect.sleep("200 millis");
        assert.strictEqual(yield* Queue.size(changes), 0);

        // A Console sign-in creates the profile folder; `.claude.json` is untouched.
        yield* fs.makeDirectory(path.join(profiles, "configs"), { recursive: true });
        yield* fs.writeFileString(path.join(profiles, "configs", "default.json"), "{}");
        yield* fs.writeFileString(path.join(profiles, "active_config"), "default");
        yield* Queue.take(changes).pipe(Effect.timeout("3 seconds"));
        yield* Effect.sleep("200 millis");
        yield* Queue.clear(changes);

        // Its sign-out, in the folder that did not exist when the watch began.
        yield* fs.remove(path.join(profiles, "active_config"));
        yield* Queue.take(changes).pipe(Effect.timeout("3 seconds"));

        // Then `/login` to another claude.ai account, by an atomic rename.
        const staged = path.join(home, ".claude.json.tmp");
        yield* fs.writeFileString(
          staged,
          claudeConfig({ accountUuid: "b", emailAddress: "b@x.dev" }),
        );
        yield* fs.rename(staged, accountFile);
        yield* Queue.take(changes).pipe(Effect.timeout("3 seconds"));
        yield* Effect.sleep("200 millis");
        assert.strictEqual(yield* Queue.size(changes), 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
