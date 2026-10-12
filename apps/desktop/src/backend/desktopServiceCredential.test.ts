import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import {
  DESKTOP_SERVICE_CREDENTIAL_FILE,
  isStoredBearerReusable,
  resolveDesktopServiceBearer,
  type DesktopServiceCredentialCrypto,
} from "./desktopServiceCredential.ts";

vi.mock("electron", () => ({ safeStorage: {} }));

const makeFilePath = () =>
  NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-desktop-credential-")),
    "userdata",
    DESKTOP_SERVICE_CREDENTIAL_FILE,
  );

// Stands in for the OS keychain: reversible, but never the plain token.
const fakeCrypto = (available = true): DesktopServiceCredentialCrypto => ({
  isEncryptionAvailable: Effect.succeed(available),
  encryptString: (value) =>
    Effect.succeed(new TextEncoder().encode(`enc:${[...value].toReversed().join("")}`)),
  decryptString: (value) => {
    const text = new TextDecoder().decode(value);
    return text.startsWith("enc:")
      ? Effect.succeed([...text.slice(4)].toReversed().join(""))
      : Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: "not encrypted by this keychain",
          }),
        );
  },
});

/** One app launch against a service that accepts the tokens in `accepted`. */
const launch = (input: {
  readonly filePath: string;
  readonly key?: string;
  readonly accepted: ReadonlySet<string>;
  readonly crypto?: DesktopServiceCredentialCrypto;
  readonly minted: Array<string>;
}) =>
  resolveDesktopServiceBearer({
    filePath: input.filePath,
    key: input.key ?? "env-mac",
    crypto: input.crypto ?? fakeCrypto(),
    isReusable: (token) => Effect.succeed(input.accepted.has(token)),
    mint: Effect.sync(() => {
      const token = `bearer-${input.minted.length + 1}`;
      input.minted.push(token);
      return token;
    }),
  });

describe("resolveDesktopServiceBearer", () => {
  it.effect("preserves the encrypted bearer and propagates a failed validation for retry", () => {
    const filePath = makeFilePath();
    return Effect.gen(function* () {
      const minted: Array<string> = [];
      const accepted = new Set<string>();
      const stored = yield* launch({ filePath, accepted, minted });
      const before = NodeFS.readFileSync(filePath);
      const failure = { _tag: "ValidationUnavailable" } as const;
      const result = yield* resolveDesktopServiceBearer({
        filePath,
        key: "env-mac",
        crypto: fakeCrypto(),
        isReusable: () => Effect.fail(failure),
        mint: Effect.sync(() => {
          minted.push("unexpected-replacement");
          return "unexpected-replacement";
        }),
      }).pipe(Effect.result);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure, failure);
      assert.deepStrictEqual(NodeFS.readFileSync(filePath), before);
      assert.deepStrictEqual(minted, [stored]);
      accepted.add(stored);
      assert.strictEqual(yield* launch({ filePath, accepted, minted }), stored);
      assert.deepStrictEqual(minted, [stored]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() =>
          NodeFS.rmSync(NodePath.dirname(NodePath.dirname(filePath)), {
            recursive: true,
            force: true,
          }),
        ),
      ),
    );
  });

  it.effect("reuses the stored session on later launches instead of minting a new one", () =>
    Effect.gen(function* () {
      const filePath = makeFilePath();
      const minted: Array<string> = [];
      const accepted = new Set<string>();

      const first = yield* launch({ filePath, accepted, minted });
      accepted.add(first);
      for (let relaunch = 0; relaunch < 5; relaunch += 1) {
        assert.strictEqual(yield* launch({ filePath, accepted, minted }), first);
      }
      assert.deepStrictEqual(minted, ["bearer-1"]);
      const file = NodeFS.readFileSync(filePath, "utf8");
      assert.notInclude(file, "bearer-1");
      assert.strictEqual((NodeFS.statSync(filePath).mode & 0o777).toString(8), "600");
    }),
  );

  it.effect("mints and replaces a stored session the service no longer accepts", () =>
    Effect.gen(function* () {
      const filePath = makeFilePath();
      const minted: Array<string> = [];
      const accepted = new Set<string>();
      accepted.add(yield* launch({ filePath, accepted, minted }));

      // Revoked from Connections, expired, or close to expiry.
      accepted.clear();
      const replacement = yield* launch({ filePath, accepted, minted });
      assert.strictEqual(replacement, "bearer-2");
      accepted.add(replacement);
      assert.strictEqual(yield* launch({ filePath, accepted, minted }), "bearer-2");
      assert.deepStrictEqual(minted, ["bearer-1", "bearer-2"]);
    }),
  );

  it.effect("keeps one stored session per service", () =>
    Effect.gen(function* () {
      const filePath = makeFilePath();
      const minted: Array<string> = [];
      const accepted = new Set<string>();
      accepted.add(yield* launch({ filePath, key: "env-mac", accepted, minted }));
      accepted.add(yield* launch({ filePath, key: "env-linux", accepted, minted }));
      assert.strictEqual(yield* launch({ filePath, key: "env-mac", accepted, minted }), "bearer-1");
      assert.strictEqual(
        yield* launch({ filePath, key: "env-linux", accepted, minted }),
        "bearer-2",
      );
      assert.deepStrictEqual(Object.keys(JSON.parse(NodeFS.readFileSync(filePath, "utf8"))), [
        "env-mac",
        "env-linux",
      ]);
    }),
  );

  it.effect("stores nothing and pairs each launch when encryption is unavailable", () =>
    Effect.gen(function* () {
      const filePath = makeFilePath();
      const minted: Array<string> = [];
      const accepted = new Set(["bearer-1", "bearer-2"]);
      const crypto = fakeCrypto(false);
      yield* launch({ filePath, accepted, minted, crypto });
      yield* launch({ filePath, accepted, minted, crypto });
      assert.deepStrictEqual(minted, ["bearer-1", "bearer-2"]);
      assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(filePath, "utf8")), {});
    }),
  );

  it.effect("treats a corrupt or undecryptable store as empty", () =>
    Effect.gen(function* () {
      const filePath = makeFilePath();
      const minted: Array<string> = [];
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
      NodeFS.writeFileSync(filePath, "{not json");
      assert.strictEqual(yield* launch({ filePath, accepted: new Set(), minted }), "bearer-1");
      NodeFS.writeFileSync(
        filePath,
        JSON.stringify({
          "env-mac": { encryptedBearerToken: Buffer.from("plain").toString("base64") },
        }),
      );
      assert.strictEqual(
        yield* launch({ filePath, accepted: new Set(["plain"]), minted }),
        "bearer-2",
      );
    }),
  );
});

describe("isStoredBearerReusable", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  const hours = (count: number) => DateTime.makeUnsafe(now + count * 60 * 60 * 1000);

  it("reuses an authenticated bearer session with more than a day left", () => {
    assert.isTrue(
      isStoredBearerReusable(
        { authenticated: true, sessionMethod: "bearer-access-token", expiresAt: hours(25) },
        now,
      ),
    );
    assert.isTrue(
      isStoredBearerReusable({ authenticated: true, sessionMethod: "bearer-access-token" }, now),
    );
  });

  it("replaces a bearer that is rejected, of another kind, or close to expiry", () => {
    assert.isFalse(
      isStoredBearerReusable(
        { authenticated: false, sessionMethod: "bearer-access-token", expiresAt: hours(100) },
        now,
      ),
    );
    assert.isFalse(
      isStoredBearerReusable(
        { authenticated: true, sessionMethod: "browser-session-cookie", expiresAt: hours(100) },
        now,
      ),
    );
    assert.isFalse(isStoredBearerReusable({ authenticated: true, expiresAt: hours(100) }, now));
    assert.isFalse(
      isStoredBearerReusable(
        { authenticated: true, sessionMethod: "bearer-access-token", expiresAt: hours(23) },
        now,
      ),
    );
  });
});

describe("credential file writes", () => {
  it.effect("replaces a leftover temporary file and keeps the store private", () =>
    Effect.gen(function* () {
      const filePath = makeFilePath();
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
      const leftover = `${filePath}.${process.pid}.tmp`;
      NodeFS.writeFileSync(leftover, "stale", { mode: 0o644 });
      yield* launch({ filePath, accepted: new Set(), minted: [] });
      assert.isFalse(NodeFS.existsSync(leftover));
      assert.strictEqual((NodeFS.statSync(filePath).mode & 0o777).toString(8), "600");
    }),
  );
});
