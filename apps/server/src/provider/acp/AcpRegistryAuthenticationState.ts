import type {
  AcpRegistrySettings,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

const decodeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ binding: Schema.String, authenticated: Schema.Boolean })),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const hash = Effect.fn("AcpRegistryAuthenticationState.hash")(function* (value: unknown) {
  const crypto = yield* Crypto.Crypto;
  const json = yield* encodeJson(value).pipe(Effect.orDie);
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(json)).pipe(Effect.orDie);
  return Hex.encode(digest);
});

const VERIFIED_NOTE_TTL_MS = 10 * 60 * 1000;
const decodePending = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      authMethodId: Schema.String,
      envName: Schema.String,
      digest: Schema.String,
      at: Schema.Number,
    }),
  ),
);
const pendingPath = Effect.fn("AcpRegistryAuthenticationState.pendingPath")(function* (
  cacheDir: string,
  instanceId: ProviderInstanceId,
) {
  const path = yield* Path.Path;
  return path.join(cacheDir, `acp-auth-pending-${yield* hash(instanceId)}.json`);
});

/**
 * Saving a verified API key rebuilds the instance, and the rebuilt instance's
 * binding differs from the one that verified it. This note lets the rebuilt
 * instance confirm sign-in when its environment holds that same key. Only a
 * digest of the key is written, and the note is removed once read.
 */
export const rememberVerifiedCredential = Effect.fn(
  "AcpRegistryAuthenticationState.rememberVerifiedCredential",
)(function* (input: {
  readonly cacheDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly authMethodId: string;
  readonly envName: string;
  readonly value: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* writeFileStringAtomically({
    filePath: yield* pendingPath(input.cacheDir, input.instanceId),
    contents: yield* encodeJson({
      authMethodId: input.authMethodId,
      envName: input.envName,
      digest: yield* hash(input.value),
      at: yield* Clock.currentTimeMillis,
    }).pipe(Effect.orDie),
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.ignore,
  );
});

export const forgetVerifiedCredential = Effect.fn(
  "AcpRegistryAuthenticationState.forgetVerifiedCredential",
)(function* (input: { readonly cacheDir: string; readonly instanceId: ProviderInstanceId }) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* pendingPath(input.cacheDir, input.instanceId)).pipe(Effect.ignore);
});

/** Remember explicit sign-in success, never discovery success or the agent's credentials. */
export const makeAcpRegistryAuthenticationState = Effect.fn("makeAcpRegistryAuthenticationState")(
  function* (input: {
    readonly cacheDir: string;
    readonly instanceId: ProviderInstanceId;
    readonly settings: AcpRegistrySettings;
    readonly environment: ProviderInstanceEnvironment;
    readonly processEnvironment: NodeJS.ProcessEnv;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(input.cacheDir, `acp-auth-${yield* hash(input.instanceId)}.json`);
    // Cosmetic settings and model discovery can rebuild the driver without
    // changing the account. Credential overrides and profile paths cannot.
    const binding = yield* hash({
      ...(input.settings.source === "local"
        ? { source: "local", commandArgs: input.settings.commandArgs }
        : {}),
      agentId: input.settings.agentId,
      commandPath: input.settings.commandPath,
      distribution: input.settings.distribution,
      authMethodId: input.settings.authMethodId,
      environment: [...input.environment].toSorted((a, b) => a.name.localeCompare(b.name)),
      profiles: [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "APPDATA",
        "LOCALAPPDATA",
      ].map((name) => input.processEnvironment[name] ?? null),
    });
    const saved = yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeState),
      Effect.orElseSucceed(() => undefined),
    );
    const pendingFile = yield* pendingPath(input.cacheDir, input.instanceId);
    const pending = yield* fs.readFileString(pendingFile).pipe(
      Effect.flatMap(decodePending),
      Effect.orElseSucceed(() => undefined),
    );
    // Sign-in trims the key before writing the note, so compare trimmed values.
    const pendingKey = pending ? input.processEnvironment[pending.envName]?.trim() : undefined;
    const now = yield* Clock.currentTimeMillis;
    // A note the rebuilt instance never used goes stale, so a key set by hand
    // later is not confirmed without a sign-in.
    const verifiedHere =
      pending !== undefined &&
      now - pending.at >= 0 &&
      now - pending.at < VERIFIED_NOTE_TTL_MS &&
      pending.authMethodId === input.settings.authMethodId &&
      pendingKey !== undefined &&
      pendingKey.length > 0 &&
      (yield* hash(pendingKey)) === pending.digest;
    if (verifiedHere) yield* fs.remove(pendingFile).pipe(Effect.ignore);
    const confirmed = yield* Ref.make(
      verifiedHere || (saved?.binding === binding && saved.authenticated),
    );
    const lock = yield* Semaphore.make(1);
    const persist = (authenticated: boolean) =>
      writeFileStringAtomically({
        filePath,
        contents: JSON.stringify({ binding, authenticated }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.tapError(() => Effect.logWarning("Could not save ACP sign-in confirmation.")),
        Effect.ignore,
      );
    if (verifiedHere) yield* persist(true);
    else if (saved && saved.binding !== binding) yield* persist(false);
    return {
      get: Ref.get(confirmed),
      set: (authenticated: boolean) =>
        lock.withPermit(
          Ref.set(confirmed, authenticated).pipe(Effect.andThen(persist(authenticated))),
        ),
    };
  },
);
