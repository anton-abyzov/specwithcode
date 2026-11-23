// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron credential bootstrap must preserve synchronous atomic encrypted-file operations.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron credential bootstrap must preserve synchronous atomic encrypted-file operations.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron credential bootstrap must preserve synchronous atomic encrypted-file operations.
import * as NodePath from "node:path";

import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthSessionState,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

/**
 * The bearer the desktop app holds for the installed Studio service, kept
 * across launches. Without it every launch paired again and left another
 * 30-day "SpecWeave Studio Desktop" session behind. The token is stored only
 * encrypted with the OS keychain (Electron safe storage); when encryption is
 * unavailable nothing is stored and each launch pairs as before.
 */
export const DESKTOP_SERVICE_CREDENTIAL_FILE = "desktop-service-credentials.json";

/** A stored bearer is reused only with at least this long left before it expires. */
export const STORED_BEARER_MIN_REMAINING_MS = 24 * 60 * 60 * 1000;

const hasAccessScopes = (granted: ReadonlyArray<string> | undefined): boolean =>
  granted === undefined ||
  (granted.includes(AuthAccessReadScope) && granted.includes(AuthAccessWriteScope));

/**
 * True when the service's session state for a stored bearer allows reusing it.
 * A bearer from a build that paired with the standard client scopes lacks the
 * access scopes, so it is replaced once by one with the administrative set.
 */
export const isStoredBearerReusable = (
  state: Pick<
    AuthSessionState,
    "authenticated" | "sessionMethod" | "expiresAt" | "scopes" | "permissions"
  >,
  nowMs: number,
): boolean =>
  state.authenticated &&
  state.sessionMethod === "bearer-access-token" &&
  hasAccessScopes(state.permissions ?? state.scopes) &&
  (state.expiresAt === undefined ||
    DateTime.toEpochMillis(state.expiresAt) - nowMs > STORED_BEARER_MIN_REMAINING_MS);

/**
 * What to do with a stored bearer: reuse it, replace it, or, for a session the
 * service accepts but does not count as the machine's owner, replace it once.
 * An older server does not report the field, which means reuse.
 */
export type StoredBearerVerdict = boolean | "not-machine-owner";

export const storedBearerVerdict = (
  state: Pick<
    AuthSessionState,
    "authenticated" | "sessionMethod" | "expiresAt" | "scopes" | "permissions" | "machineOwner"
  >,
  nowMs: number,
): StoredBearerVerdict =>
  !isStoredBearerReusable(state, nowMs)
    ? false
    : state.machineOwner === false
      ? "not-machine-owner"
      : true;

export type DesktopServiceCredentialCrypto = Pick<
  ElectronSafeStorage.ElectronSafeStorage["Service"],
  "isEncryptionAvailable" | "encryptString" | "decryptString"
>;

class DesktopServiceCredentialStoreError extends Schema.TaggedError<DesktopServiceCredentialStoreError>()(
  "DesktopServiceCredentialStoreError",
  { cause: Schema.Defect() },
) {}

interface CredentialEntry {
  readonly encryptedBearerToken?: string;
  /** The secret that proves this app owns the machine; the service holds only its hash. */
  readonly encryptedOwnerProof?: string;
  /** A session that was not the owner was already replaced once: do not mint another. */
  readonly ownerRemintTried?: boolean;
}

type CredentialFile = Record<string, CredentialEntry>;

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const readCredentialFile = (filePath: string): CredentialFile => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const entries: Record<string, CredentialEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const raw = (value ?? {}) as Record<string, unknown>;
      const encryptedBearerToken = nonEmptyString(raw.encryptedBearerToken);
      const encryptedOwnerProof = nonEmptyString(raw.encryptedOwnerProof);
      if (encryptedBearerToken === undefined && encryptedOwnerProof === undefined) continue;
      entries[key] = {
        ...(encryptedBearerToken === undefined ? {} : { encryptedBearerToken }),
        ...(encryptedOwnerProof === undefined ? {} : { encryptedOwnerProof }),
        ...(raw.ownerRemintTried === true ? { ownerRemintTried: true } : {}),
      };
    }
    return entries;
  } catch {
    return {};
  }
};

const writeCredentialFile = (filePath: string, entries: CredentialFile): void => {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  // A leftover temporary file from a crash would keep its old mode, so the
  // file is always created fresh ("wx") and removed if the rename fails.
  NodeFS.rmSync(temporaryPath, { force: true });
  try {
    NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    NodeFS.renameSync(temporaryPath, filePath);
  } catch (error) {
    NodeFS.rmSync(temporaryPath, { force: true });
    throw error;
  }
};

/** Merges `change` into one entry, keeping what it does not name; null removes the entry. */
const updateEntry = (filePath: string, key: string, change: CredentialEntry | null) =>
  Effect.try({
    try: () => {
      const { [key]: previous, ...others } = readCredentialFile(filePath);
      writeCredentialFile(
        filePath,
        change === null ? others : { ...others, [key]: { ...previous, ...change } },
      );
    },
    catch: (cause) => new DesktopServiceCredentialStoreError({ cause }),
  });

/** `<stateDir>/secrets/`: the service reads it as its `desktop-owner-verifier` secret. */
export const DESKTOP_OWNER_VERIFIER_FILE = "desktop-owner-verifier.bin";

/**
 * The secret this app presents once at token exchange so its session counts as
 * the machine's owner, which a pair token alone never does. Kept per service,
 * encrypted. Without encryption it lasts this launch and its hash is rewritten.
 */
export const resolveDesktopOwnerProof = (input: {
  readonly filePath: string;
  readonly key: string;
  readonly crypto: DesktopServiceCredentialCrypto;
}): Effect.Effect<string> =>
  Effect.gen(function* () {
    const encryptionAvailable = yield* input.crypto.isEncryptionAvailable.pipe(
      Effect.orElseSucceed(() => false),
    );
    if (encryptionAvailable) {
      const stored = readCredentialFile(input.filePath)[input.key]?.encryptedOwnerProof;
      if (stored !== undefined) {
        const proof = yield* input.crypto
          .decryptString(Uint8Array.from(Buffer.from(stored, "base64")))
          .pipe(Effect.orElseSucceed(() => null));
        if (proof !== null) return proof;
      }
    }
    const proof = NodeCrypto.randomBytes(32).toString("base64url");
    if (encryptionAvailable) {
      yield* input.crypto.encryptString(proof).pipe(
        Effect.flatMap((encrypted) =>
          updateEntry(input.filePath, input.key, {
            encryptedOwnerProof: Buffer.from(encrypted).toString("base64"),
          }),
        ),
        Effect.ignore,
      );
    }
    return proof;
  });

/** The proof is only ever sent to a service on this machine's own loopback address. */
export const isLoopbackServiceUrl = (url: URL): boolean =>
  /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|localhost)$/i.test(url.hostname);

/** Writes the proof's hash where the service reads it: a temporary file, then a rename. */
export const writeDesktopOwnerVerifier = (stateDir: string, proof: string) =>
  Effect.try({
    try: () => {
      const directory = NodePath.join(stateDir, "secrets");
      NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = NodePath.join(directory, DESKTOP_OWNER_VERIFIER_FILE);
      const temporaryPath = `${target}.${process.pid}.tmp`;
      NodeFS.rmSync(temporaryPath, { force: true });
      try {
        NodeFS.writeFileSync(
          temporaryPath,
          NodeCrypto.createHash("sha256").update(proof, "utf8").digest(),
          { mode: 0o600, flag: "wx" },
        );
        NodeFS.renameSync(temporaryPath, target);
      } catch (error) {
        NodeFS.rmSync(temporaryPath, { force: true });
        throw error;
      }
    },
    catch: (cause) => new DesktopServiceCredentialStoreError({ cause }),
  });

/**
 * Returns the stored bearer for `key` when the service still accepts it,
 * otherwise mints a new one with `mint` and stores it. A rejected or
 * unreadable stored bearer is replaced; storage failures never block `mint`.
 * Validation failures leave the stored bearer untouched and propagate for retry.
 */
export const resolveDesktopServiceBearer = <E, EValidation = never>(input: {
  readonly filePath: string;
  readonly key: string;
  readonly crypto: DesktopServiceCredentialCrypto;
  /** Whether the service still accepts the bearer for long enough to reuse it. */
  readonly isReusable: (bearerToken: string) => Effect.Effect<StoredBearerVerdict, EValidation>;
  readonly mint: Effect.Effect<string, E>;
}): Effect.Effect<string, E | EValidation> =>
  Effect.gen(function* () {
    const encryptionAvailable = yield* input.crypto.isEncryptionAvailable.pipe(
      Effect.orElseSucceed(() => false),
    );
    const store = (bearerToken: string, ownerRemintTried: boolean) =>
      (encryptionAvailable
        ? input.crypto.encryptString(bearerToken).pipe(
            Effect.flatMap((encrypted) =>
              updateEntry(input.filePath, input.key, {
                encryptedBearerToken: Buffer.from(encrypted).toString("base64"),
                ownerRemintTried,
              }),
            ),
          )
        : updateEntry(input.filePath, input.key, null)
      ).pipe(Effect.ignore);

    if (encryptionAvailable) {
      const stored = readCredentialFile(input.filePath)[input.key];
      if (stored?.encryptedBearerToken !== undefined) {
        const bearerToken = yield* input.crypto
          .decryptString(Uint8Array.from(Buffer.from(stored.encryptedBearerToken, "base64")))
          .pipe(Effect.orElseSucceed(() => null));
        if (bearerToken !== null) {
          const verdict = yield* input.isReusable(bearerToken);
          if (verdict === true) return bearerToken;
          if (verdict === "not-machine-owner") {
            // One attempt only, recorded first: each mint is another 30-day session.
            if (stored.ownerRemintTried === true) return bearerToken;
            yield* updateEntry(input.filePath, input.key, { ownerRemintTried: true }).pipe(
              Effect.ignore,
            );
            const replaced = yield* Effect.result(input.mint);
            if (Result.isFailure(replaced)) return bearerToken;
            yield* store(replaced.success, true);
            return replaced.success;
          }
        }
      }
    }

    const bearerToken = yield* input.mint;
    yield* store(bearerToken, false);
    return bearerToken;
  }).pipe(Effect.withSpan("desktop.resolveDesktopServiceBearer"));
