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

export type DesktopServiceCredentialCrypto = Pick<
  ElectronSafeStorage.ElectronSafeStorage["Service"],
  "isEncryptionAvailable" | "encryptString" | "decryptString"
>;

class DesktopServiceCredentialStoreError extends Schema.TaggedError<DesktopServiceCredentialStoreError>()(
  "DesktopServiceCredentialStoreError",
  { cause: Schema.Defect() },
) {}

type CredentialFile = Record<string, { readonly encryptedBearerToken: string }>;

const readCredentialFile = (filePath: string): CredentialFile => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const entries: Record<string, { encryptedBearerToken: string }> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const encrypted = (value as { encryptedBearerToken?: unknown } | null)?.encryptedBearerToken;
      if (typeof encrypted === "string" && encrypted.length > 0) {
        entries[key] = { encryptedBearerToken: encrypted };
      }
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

const updateEntry = (filePath: string, key: string, encryptedBearerToken: string | null) =>
  Effect.try({
    try: () => {
      const { [key]: _previous, ...others } = readCredentialFile(filePath);
      writeCredentialFile(
        filePath,
        encryptedBearerToken === null ? others : { ...others, [key]: { encryptedBearerToken } },
      );
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
  /** True when the service still accepts the bearer for long enough to reuse it. */
  readonly isReusable: (bearerToken: string) => Effect.Effect<boolean, EValidation>;
  readonly mint: Effect.Effect<string, E>;
}): Effect.Effect<string, E | EValidation> =>
  Effect.gen(function* () {
    const encryptionAvailable = yield* input.crypto.isEncryptionAvailable.pipe(
      Effect.orElseSucceed(() => false),
    );
    if (encryptionAvailable) {
      const stored = readCredentialFile(input.filePath)[input.key];
      if (stored !== undefined) {
        const bearerToken = yield* input.crypto
          .decryptString(Uint8Array.from(Buffer.from(stored.encryptedBearerToken, "base64")))
          .pipe(Effect.orElseSucceed(() => null));
        if (bearerToken !== null && (yield* input.isReusable(bearerToken))) return bearerToken;
      }
    }

    const bearerToken = yield* input.mint;
    yield* (
      encryptionAvailable
        ? input.crypto
            .encryptString(bearerToken)
            .pipe(
              Effect.flatMap((encrypted) =>
                updateEntry(input.filePath, input.key, Buffer.from(encrypted).toString("base64")),
              ),
            )
        : updateEntry(input.filePath, input.key, null)
    ).pipe(Effect.ignore);
    return bearerToken;
  }).pipe(Effect.withSpan("desktop.resolveDesktopServiceBearer"));
