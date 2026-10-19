import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import type { ProviderInstanceId } from "@specweave-studio/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { withChatGptSessionLock } from "./CodexChatGptSessionLock.ts";

/** A provider binding stores opaque bytes; only its adapter decodes or refreshes them. */
export const make = Effect.fn("ProviderCredentialStore.make")(function* (
  driver: string,
  bindingId: string,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  // Hash the tuple so arbitrary bindings cannot escape or exceed a filename.
  const bindingHash = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`${driver.length}:${driver}${bindingId}`))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  const key = `provider-auth-${bindingHash}`;
  return {
    binding: { owner: "specweave-studio" as const, key },
    get: secrets.get(key),
    set: (credentials: Uint8Array) => secrets.set(key, credentials),
    remove: secrets.remove(key),
  };
});

/**
 * Secret-store bindings each provider driver keys by its instance id. A Map:
 * driver kinds are client-chosen slugs, and `constructor` or `toString` must
 * not resolve to an Object.prototype member.
 */
const INSTANCE_CREDENTIAL_BINDINGS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["codex", ["codex-chatgpt", "codex-chatgpt-registration"]],
  ["cursor", ["cursor"]],
]);

/** Removes the sign-in a deleted provider instance would otherwise leave behind. */
export const removeInstanceCredentials = Effect.fn(
  "ProviderCredentialStore.removeInstanceCredentials",
)(function* (providerDriver: string, instanceId: ProviderInstanceId) {
  const bindings = INSTANCE_CREDENTIAL_BINDINGS.get(providerDriver) ?? [];
  if (bindings.length === 0) return;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const stores = yield* Effect.forEach(bindings, (driver) => make(driver, instanceId));
  const removeAll = Effect.forEach(stores, (store) => store.remove, { discard: true });
  if (providerDriver !== "codex") return yield* removeAll;
  // Codex sign-in, token refresh, sign-out and import hold this lock on the
  // session binding, across servers sharing the secret store, so the delete
  // never interleaves with one of them writing this instance's tokens.
  return yield* withChatGptSessionLock(
    secrets.directory,
    stores[0]!.binding.key,
    instanceId,
    removeAll,
  );
});
