/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  AcpRegistrySettings,
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  MuseSettings,
  OpenCodeSettings,
  PiSettings,
  providerSettingsPasswordKeys,
  REDACTED_SECRET_MARKER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProjectSettingsOverrides,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type ProviderInstanceMutation,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ResponseStreamingMode,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@specweave-studio/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import { resolveSymlinkTarget } from "@specweave-studio/shared/symlink";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@specweave-studio/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@specweave-studio/shared/schemaJson";
import {
  applyServerSettingsPatch,
  deriveLegacyProjectOverrides,
  simplifyProjectSettingsOverrides,
  isModelSelectionProviderEnabled,
} from "@specweave-studio/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ProviderCredentialStore from "./provider/ProviderCredentialStore.ts";
import { removeAntigravityInstanceProfile } from "./provider/antigravityAuthSupport.ts";

export { resolveSourceControlWriterModelSelection } from "@specweave-studio/shared/serverSettings";

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsJson = Schema.encodeUnknownEffect(fromJsonStringPretty(ServerSettings));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Fold the legacy in-config `enabled` flag into the envelope-level
 * `ProviderInstanceConfig.enabled` and strip it from the config blob, so
 * explicit provider instances carry exactly one enabled flag. Old settings
 * files can hold both flags with conflicting values; an explicit false on
 * either side wins so a user's disable is never silently undone. Runs on
 * every load and update — the file converges on the next write.
 */
const foldProviderInstanceEnabledFlags = (settings: ServerSettings): ServerSettings => {
  let changed = false;
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    const config = instance.config;
    // Only fold boolean flags: a malformed `enabled` (e.g. `"false"`) must
    // stay in the blob so driver schema validation flags it instead of the
    // fold silently repairing the config.
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      typeof (config as { readonly enabled?: unknown }).enabled !== "boolean"
    ) {
      providerInstances[instanceId] = instance;
      continue;
    }
    const { enabled: configEnabled, ...restConfig } = config as Record<string, unknown> & {
      readonly enabled: boolean;
    };
    const resolved =
      instance.enabled === false || configEnabled === false
        ? false
        : (instance.enabled ?? configEnabled);
    changed = true;
    providerInstances[instanceId] = {
      ...instance,
      enabled: resolved,
      config: restConfig,
    } satisfies ProviderInstanceConfig;
  }
  if (!changed) {
    return settings;
  }
  return {
    ...settings,
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
};

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.map(foldProviderInstanceEnabledFlags),
    Effect.map((next) => ({ ...next, ...deriveLegacyProjectOverrides(next) })),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

/**
 * On disk a hub key or Bitbucket token is replaced by this marker and the
 * real value lives in the secret store, mirroring provider environment
 * secrets. A client that sends the marker back means "keep what you have".
 */
const SECRET_REDACTED = REDACTED_SECRET_MARKER;

function usageLimitSourceSecretName(sourceId: string): string {
  return `usage-limit-source-${Buffer.from(sourceId, "utf8").toString("base64url")}`;
}

function sameUrlOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

const BITBUCKET_SECRET_NAMES = {
  accessToken: "bitbucket-access-token",
  apiToken: "bitbucket-api-token",
} as const;
const BITBUCKET_SECRET_FIELDS = ["accessToken", "apiToken"] as const;
const ELEVENLABS_VOICE_SECRET_NAME = "elevenlabs-voice-api-key";

/** Hosts are case-insensitive; a patch can arrive before decoding lowercased its keys. */
function gitHubTokenSecretName(host: string): string {
  return `github-token-${Buffer.from(host.trim().toLowerCase(), "utf8").toString("base64url")}`;
}

const redactSecret = (value: string) => (value.length > 0 ? SECRET_REDACTED : "");

function redactProviderEnvironmentVariable(
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  if (!variable.sensitive) {
    const { valueRedacted: _omit, ...rest } = variable;
    return rest;
  }
  return {
    ...variable,
    value: "",
    ...(variable.value.length > 0 || variable.valueRedacted ? { valueRedacted: true } : {}),
  };
}

const PROVIDER_SETTINGS_SCHEMAS = {
  acpRegistry: AcpRegistrySettings,
  antigravity: AntigravitySettings,
  claudeAgent: ClaudeSettings,
  codex: CodexSettings,
  cursor: CursorSettings,
  grok: GrokSettings,
  muse: MuseSettings,
  opencode: OpenCodeSettings,
  pi: PiSettings,
} as const;

/**
 * Password fields of each known driver's settings (empty when it has none),
 * keyed by driver kind (which is also the key in the legacy `providers`
 * struct). Derived from the form annotation, so a new password field is
 * redacted without touching this file. A driver missing here is unknown to
 * this build: its whole config is opaque (see `redactOpaqueConfigValue`).
 * These values stay where they are stored today; only client copies change.
 */
export const PROVIDER_SETTINGS_SECRET_KEYS: Readonly<Record<string, ReadonlyArray<string>>> =
  Object.fromEntries(
    Object.entries(PROVIDER_SETTINGS_SCHEMAS).map(
      ([driver, schema]) => [driver, providerSettingsPasswordKeys(schema)] as const,
    ),
  );

/**
 * Address fields (`serverUrl`, `apiEndpoint`, `baseUrl`...) of each known
 * driver: where its password, or a token kept in an opaque key, is sent.
 * Only addresses count: a changed binary or command path, or instance
 * environment, already runs code as the server user, which can read every
 * stored secret anyway, so those edits keep the stored values.
 */
export const PROVIDER_SETTINGS_SECRET_DESTINATION_KEYS: Readonly<
  Record<string, ReadonlyArray<string>>
> = Object.fromEntries(
  Object.entries(PROVIDER_SETTINGS_SCHEMAS).map(([driver, schema]) => [
    driver,
    Object.keys(schema.fields).filter((key) => /(url|endpoint)$/i.test(key)),
  ]),
);

/**
 * Non-secret keys a client writes into a known driver's config besides its
 * schema fields. Clients read them back, so they are not withheld:
 * - `acpRegistry.registryIconUrl`: the Registry icon the add dialog stores.
 * - `muse.customModels`: the instance card manages custom models for every
 *   driver but Antigravity, and Muse's schema has no such field.
 * Every other key the web and mobile clients read or write is a schema field.
 */
const PROVIDER_SETTINGS_PUBLIC_METADATA_KEYS: Readonly<Record<string, ReadonlyArray<string>>> = {
  acpRegistry: ["registryIconUrl"],
  muse: ["customModels"],
};

/** Keys this build knows for each driver; any other config key is opaque. */
const PROVIDER_SETTINGS_FIELD_KEYS: Readonly<Record<string, ReadonlyArray<string>>> =
  Object.fromEntries(
    Object.entries(PROVIDER_SETTINGS_SCHEMAS).map(([driver, schema]) => [
      driver,
      [
        ...Object.keys(schema.fields),
        ...(ownEntry(PROVIDER_SETTINGS_PUBLIC_METADATA_KEYS, driver) ?? []),
      ],
    ]),
  );

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads an own property only. Driver kinds and instance ids are client-chosen
 * slugs, so `constructor` or `toString` must not resolve to Object.prototype.
 */
function ownEntry<R extends object>(record: R | undefined, key: string): R[keyof R] | undefined {
  return record !== undefined && Object.hasOwn(record, key)
    ? (record as Record<string, R[keyof R]>)[key]
    : undefined;
}

/**
 * How a driver's config holds secrets. `passwordKeys` are the known password
 * fields. Every other key this build does not know as a field of the driver
 * (all of them for a driver it does not know, or for a broken lookup) is
 * opaque: a newer build or another tool may keep a token there, nested in
 * objects or arrays, so every string in it is treated as a secret.
 */
function providerConfigSecretLayout(driver: string): {
  readonly passwordKeys: ReadonlyArray<string>;
  readonly isOpaque: (key: string) => boolean;
} {
  const passwordKeys: unknown = ownEntry(PROVIDER_SETTINGS_SECRET_KEYS, driver);
  const fields: unknown = ownEntry(PROVIDER_SETTINGS_FIELD_KEYS, driver);
  if (!Array.isArray(passwordKeys) || !Array.isArray(fields)) {
    return { passwordKeys: [], isOpaque: () => true };
  }
  const known = new Set<string>(fields as ReadonlyArray<string>);
  return {
    passwordKeys: passwordKeys as ReadonlyArray<string>,
    isOpaque: (key) => !known.has(key),
  };
}

/** Replaces every non-empty string inside an opaque value, at any depth, with the marker. */
function redactOpaqueConfigValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > 0 ? SECRET_REDACTED : value;
  if (Array.isArray(value)) return value.map(redactOpaqueConfigValue);
  if (isConfigRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactOpaqueConfigValue(entry)]),
    );
  }
  return value;
}

function containsRedactedMarker(value: unknown): boolean {
  if (value === SECRET_REDACTED) return true;
  if (Array.isArray(value)) return value.some(containsRedactedMarker);
  if (isConfigRecord(value)) return Object.values(value).some(containsRedactedMarker);
  return false;
}

/**
 * True when an opaque value holds a string, other than the marker, that the
 * stored value does not hold at the same path: the caller changed something
 * it cannot see the meaning of, such as the address a token is sent to.
 */
function opaqueConfigValueEdited(next: unknown, stored: unknown): boolean {
  if (typeof next === "string") return next !== SECRET_REDACTED && next !== stored;
  if (Array.isArray(next)) {
    return next.some((entry, index) =>
      opaqueConfigValueEdited(entry, Array.isArray(stored) ? stored[index] : undefined),
    );
  }
  if (isConfigRecord(next)) {
    return Object.entries(next).some(([key, entry]) =>
      opaqueConfigValueEdited(entry, isConfigRecord(stored) ? ownEntry(stored, key) : undefined),
    );
  }
  return false;
}

const DROPPED = Symbol("dropped");

/**
 * Mirrors `redactOpaqueConfigValue`: a marker restores the stored string at
 * the same path when `keep`, and is dropped otherwise (an array keeps its
 * length with an empty string in its place).
 */
function restoreOpaqueConfigValue(next: unknown, stored: unknown, keep: boolean): unknown {
  if (next === SECRET_REDACTED) {
    return keep && typeof stored === "string" && stored.length > 0 && stored !== SECRET_REDACTED
      ? stored
      : DROPPED;
  }
  if (Array.isArray(next)) {
    return next.map((entry, index) => {
      const restored = restoreOpaqueConfigValue(
        entry,
        Array.isArray(stored) ? stored[index] : undefined,
        keep,
      );
      return restored === DROPPED ? "" : restored;
    });
  }
  if (isConfigRecord(next)) {
    return Object.fromEntries(
      Object.entries(next).flatMap(([key, entry]) => {
        const restored = restoreOpaqueConfigValue(
          entry,
          isConfigRecord(stored) ? ownEntry(stored, key) : undefined,
          keep,
        );
        return restored === DROPPED ? [] : [[key, restored]];
      }),
    );
  }
  return next;
}

function redactProviderConfigSecrets<T>(driver: string, config: T): T {
  // A config that is not an object (an array or a string an unknown driver
  // keeps) has no keys to sort, so all of it is opaque.
  if (!isConfigRecord(config)) return redactOpaqueConfigValue(config) as T;
  const { passwordKeys, isOpaque } = providerConfigSecretLayout(driver);
  let next: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(config)) {
    const redacted = passwordKeys.includes(key)
      ? typeof value === "string" && value.length > 0
        ? SECRET_REDACTED
        : value
      : isOpaque(key)
        ? redactOpaqueConfigValue(value)
        : value;
    if (redacted === value) continue;
    next ??= { ...config };
    next[key] = redacted;
  }
  return (next ?? config) as T;
}

function readConfigString(config: unknown, key: string): string {
  const value = isConfigRecord(config) ? config[key] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

/** True when a password would now go to a different origin than the one it was saved for. */
function providerSecretDestinationChanged(driver: string, next: unknown, current: unknown) {
  const keys: unknown = ownEntry(PROVIDER_SETTINGS_SECRET_DESTINATION_KEYS, driver);
  return (Array.isArray(keys) ? (keys as ReadonlyArray<string>) : []).some((key) => {
    const before = readConfigString(current, key);
    const after = readConfigString(next, key);
    return before !== after && !sameUrlOrigin(before, after);
  });
}

/**
 * A client edits provider settings from its redacted copy, so a password
 * field arrives as the marker unless the user typed a new value. The marker
 * restores the stored value of the same field; anything else replaces it.
 *
 * Like the usage hub key, a stored password never follows its config to a new
 * origin: when an address field moves, the marker (or the stored value kept by
 * a partial `providers` patch) is dropped until the user enters it again.
 */
function restoreProviderConfigSecrets<T>(
  driver: string,
  next: T,
  current: unknown,
  // Whether the caller sent this key itself. A value it typed is kept even
  // when the address moves; only the marker or a merged-in stored value is not.
  sentByCaller: (key: string) => boolean,
): T {
  if (!isConfigRecord(next)) {
    // Mirrors the redaction of a config that is not an object.
    if (!containsRedactedMarker(next)) return next;
    const keep =
      !providerSecretDestinationChanged(driver, next, current) &&
      !opaqueConfigValueEdited(next, current);
    const restored = restoreOpaqueConfigValue(next, current, keep);
    return (restored === DROPPED ? "" : restored) as T;
  }
  const { passwordKeys, isOpaque } = providerConfigSecretLayout(driver);
  const opaqueKeys = Object.keys(next).filter((key) => isOpaque(key));
  const keys = passwordKeys.filter((key) => Object.hasOwn(next, key));
  if (keys.length === 0 && !opaqueKeys.some((key) => containsRedactedMarker(next[key]))) {
    return next;
  }
  const destinationChanged = providerSecretDestinationChanged(driver, next, current);
  const storedValue = (key: string) =>
    isConfigRecord(current) ? ownEntry(current, key) : undefined;
  let restored: Record<string, unknown> | undefined;
  for (const key of keys) {
    const value = next[key];
    const stored = storedValue(key);
    const reusesStored =
      value === SECRET_REDACTED ||
      (!sentByCaller(key) && typeof stored === "string" && stored.length > 0 && value === stored);
    if (!reusesStored) continue;
    if (value !== SECRET_REDACTED && !destinationChanged) continue;
    restored ??= { ...next };
    if (!destinationChanged && typeof stored === "string" && stored !== SECRET_REDACTED) {
      restored[key] = stored;
    } else {
      delete restored[key];
    }
  }
  // Opaque values follow the same rule without knowing which field is the
  // address: any edited string among them, or a moved known address, drops
  // every marker in them instead of restoring the stored secret.
  const keepOpaque =
    !destinationChanged &&
    !opaqueKeys.some((key) => opaqueConfigValueEdited(next[key], storedValue(key)));
  for (const key of opaqueKeys) {
    if (!containsRedactedMarker(next[key])) continue;
    const value = restoreOpaqueConfigValue(next[key], storedValue(key), keepOpaque);
    restored ??= { ...next };
    if (value === DROPPED) delete restored[key];
    else restored[key] = value;
  }
  return (restored ?? next) as T;
}

function restoreRedactedProviderSettingsSecrets(
  current: ServerSettings,
  next: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  let providers: Record<string, unknown> | undefined;
  for (const [driver, config] of Object.entries(next.providers)) {
    // `providers` entries are merged, so a key the patch left out still holds
    // the stored value; only keys the patch names came from the caller.
    const sent = ownEntry(patch.providers as Record<string, unknown> | undefined, driver);
    const restored = restoreProviderConfigSecrets(
      driver,
      config,
      ownEntry(current.providers as Record<string, unknown>, driver),
      (key) => isConfigRecord(sent) && Object.hasOwn(sent, key),
    );
    if (restored === config) continue;
    providers ??= { ...next.providers };
    providers[driver] = restored;
  }
  let providerInstances: Record<string, ProviderInstanceConfig> | undefined;
  for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
    if (instance.config === undefined) continue;
    const previous = ownEntry(current.providerInstances, instanceId);
    // The first edit of a built-in default instance moves its config out of
    // the legacy `providers` entry, so that entry holds the stored secret.
    const previousConfig =
      previous !== undefined
        ? previous.driver === instance.driver
          ? previous.config
          : undefined
        : instanceId === instance.driver
          ? ownEntry(current.providers as Record<string, unknown>, instance.driver)
          : undefined;
    // Instance configs are replaced whole, so every value in one was sent.
    const config = restoreProviderConfigSecrets(
      instance.driver,
      instance.config,
      previousConfig,
      () => true,
    );
    if (config === instance.config) continue;
    providerInstances ??= { ...next.providerInstances };
    providerInstances[instanceId] = { ...instance, config };
  }
  if (providers === undefined && providerInstances === undefined) return next;
  return {
    ...next,
    ...(providers ? { providers: providers as ServerSettings["providers"] } : {}),
    ...(providerInstances
      ? { providerInstances: providerInstances as ServerSettings["providerInstances"] }
      : {}),
  };
}

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  const providers = Object.fromEntries(
    Object.entries(settings.providers).map(([driver, config]) => [
      driver,
      redactProviderConfigSecrets(driver, config),
    ]),
  ) as ServerSettings["providers"];
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      const config =
        instance.config === undefined
          ? undefined
          : redactProviderConfigSecrets(instance.driver, instance.config);
      return [
        instanceId,
        {
          ...instance,
          ...(instance.environment
            ? { environment: instance.environment.map(redactProviderEnvironmentVariable) }
            : {}),
          ...(config !== undefined ? { config } : {}),
        },
      ];
    }),
  );
  // The hub key is a bearer secret; clients only need to know one is set.
  const usageLimitSources = Object.fromEntries(
    Object.entries(settings.usageLimitSources).map(([id, source]) => [
      id,
      {
        ...source,
        managementKey: redactSecret(source.managementKey),
      },
    ]),
  );
  const bitbucket = {
    ...settings.bitbucket,
    accessToken: redactSecret(settings.bitbucket.accessToken),
    apiToken: redactSecret(settings.bitbucket.apiToken),
  };
  const github = {
    ...settings.github,
    tokens: Object.fromEntries(
      Object.entries(settings.github.tokens).map(([host, token]) => [host, redactSecret(token)]),
    ),
  };
  const voice = {
    ...settings.voice,
    elevenLabsApiKey: redactSecret(settings.voice.elevenLabsApiKey),
  };
  return {
    ...settings,
    providers,
    providerInstances,
    usageLimitSources,
    bitbucket,
    github,
    voice,
  };
}

type InstanceSignIn = { readonly driver: string; readonly instanceId: ProviderInstanceId };

/**
 * Ids removed by an explicit remove whose sign-in may still be on disk, with
 * the driver of each removed instance. Persisted beside the settings so a
 * failed cleanup is retried before the id is used again.
 *
 * `readded`: a write added the id back after clearing its leftovers. Until
 * the provider registry is about to start the new instance, the removed
 * one's driver may still be shutting down and write its token back, so the
 * entry stays for `clearSignInsBeforeStart` to delete once more first.
 */
type SignInTombstone = { readonly driver: string; readonly readded?: boolean };
type SignInTombstones = Readonly<Record<string, ReadonlyArray<SignInTombstone>>>;
type SignInTombstoneState = "removed" | "readded" | "gone";

const SIGN_IN_TOMBSTONES_FILE = "provider-sign-in-tombstones.json";

const SignInTombstonesJson = fromJsonStringPretty(
  Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({ driver: Schema.String, readded: Schema.optionalKey(Schema.Boolean) }),
    ),
  ),
);
const decodeSignInTombstones = Schema.decodeUnknownOption(SignInTombstonesJson);
const encodeSignInTombstones = Schema.encodeEffect(SignInTombstonesJson);

function hasSignInTombstone(tombstones: SignInTombstones, { driver, instanceId }: InstanceSignIn) {
  return (ownEntry(tombstones, instanceId) ?? []).some((entry) => entry.driver === driver);
}

function withSignInTombstone(
  tombstones: SignInTombstones,
  { driver, instanceId }: InstanceSignIn,
  state: SignInTombstoneState,
): SignInTombstones {
  const others = (ownEntry(tombstones, instanceId) ?? []).filter(
    (entry) => entry.driver !== driver,
  );
  const next: Record<string, ReadonlyArray<SignInTombstone>> = { ...tombstones };
  if (state !== "gone") {
    next[instanceId] = [...others, state === "readded" ? { driver, readded: true } : { driver }];
  } else if (others.length > 0) next[instanceId] = others;
  else delete next[instanceId];
  return next;
}

/**
 * Sorts the tombstones a write meets. Entries already `readded` wait for the
 * registry (see `SignInTombstone`) and are neither cleared nor stale here.
 *
 * `clear`: an id the write adds back (absent before, or now under another
 * driver) must start signed out, so the sign-in its removed namesake left is
 * deleted before the write. Ids without a tombstone are never cleared, so a
 * whole-map write that re-adds an instance a stale client dropped keeps it.
 *
 * `stale`: an instance live before and after the write under the tombstoned
 * driver is not removed; the tombstone is left over from a remove that was
 * interrupted or failed to save. Its sign-in belongs to the live instance,
 * so only the tombstone goes, whatever the write names.
 */
function classifySignInTombstones(
  current: ServerSettings,
  next: ServerSettings,
  tombstones: SignInTombstones,
): {
  readonly clear: ReadonlyArray<InstanceSignIn>;
  readonly stale: ReadonlyArray<InstanceSignIn>;
} {
  const clear: Array<InstanceSignIn> = [];
  const stale: Array<InstanceSignIn> = [];
  for (const [instanceId, entries] of Object.entries(tombstones)) {
    const before = ownEntry(current.providerInstances, instanceId);
    const after = ownEntry(next.providerInstances, instanceId);
    for (const { driver, readded } of entries) {
      if (readded === true) continue;
      const signIn = { driver, instanceId: instanceId as ProviderInstanceId };
      if (before?.driver === driver && after?.driver === driver) stale.push(signIn);
      else if (after !== undefined && before?.driver !== after.driver) clear.push(signIn);
    }
  }
  return { clear, stale };
}

export function applyProviderInstanceMutation(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
): ServerSettings {
  const providerInstances = { ...settings.providerInstances };
  if (mutation.operation === "upsert" || mutation.operation === "create") {
    providerInstances[mutation.instanceId] = mutation.instance;
  } else {
    delete providerInstances[mutation.instanceId];
  }
  return { ...settings, providerInstances };
}

function ensureProviderInstanceMutationAllowed(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
  settingsPath: string,
): Effect.Effect<void, ServerSettingsError> {
  if (
    mutation.operation === "create" &&
    ownEntry(settings.providerInstances, mutation.instanceId) !== undefined
  ) {
    return Effect.fail(
      new ServerSettingsError({
        settingsPath,
        operation: "create-provider-instance",
        providerInstanceId: mutation.instanceId,
      }),
    );
  }
  return Effect.void;
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    /** Start the settings runtime and attach file watching. */
    readonly start: Effect.Effect<void, ServerSettingsError>;

    /** Await settings runtime readiness. */
    readonly ready: Effect.Effect<void, ServerSettingsError>;

    /** Read the current settings. */
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Patch settings and persist. Returns the new full settings object. */
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Apply a patch and one provider-instance mutation against the same latest settings snapshot. */
    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch?: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Run an effect against a settings snapshot while settings writes are paused. */
    readonly withSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerSettingsError, R>;

    /** Stream of settings change events. */
    readonly streamChanges: Stream.Stream<ServerSettings>;

    /**
     * Acquire a settings change subscription synchronously in the current
     * fiber. Use this before reading a snapshot when changes between the
     * snapshot and a lazily started stream must not be lost.
     */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;

    /**
     * Finish removing the sign-ins of explicitly removed provider instances.
     * Call it after the provider registry has disposed every instance not in
     * `runningInstanceIds`; a removed instance's tombstone stays until then.
     * Never fails. Absent from test doubles, which keep no sign-ins.
     */
    readonly clearRemovedInstanceSignIns?: (
      runningInstanceIds: Iterable<string>,
    ) => Effect.Effect<void>;

    /**
     * Call just before the provider registry starts `instanceIds`, after it
     * disposed what ran under them before. Deletes the sign-in a removed
     * instance of a re-added id may have written while shutting down. Returns
     * the ids that must not start yet because that delete failed.
     */
    readonly clearSignInsBeforeStart?: (
      instanceIds: Iterable<string>,
    ) => Effect.Effect<ReadonlySet<string>>;

    /**
     * Of `instanceIds`, the ones re-added whose old sign-in
     * `clearSignInsBeforeStart` has not deleted yet. The registry stops
     * whatever still runs under them and clears before it starts the new one.
     */
    readonly instancesAwaitingSignInClear?: (
      instanceIds: Iterable<string>,
    ) => Effect.Effect<ReadonlySet<string>>;
  }
>()("specweave-studio/serverSettings/ServerSettingsService") {
  /** @deprecated Import and use `layerTest` from this module. */
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const makeTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Effect.gen(function* () {
    const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
      overrides;
    const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
    const initialSettings = yield* normalizeServerSettings({
      ...merged,
      ...(automaticGitFetchInterval !== undefined
        ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
        : {}),
      ...(providerHealthRefreshInterval !== undefined
        ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
        : {}),
    });
    const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);
    const writeSemaphore = yield* Semaphore.make(1);
    const getSettings = Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider));

    const updateTestSettings = (
      update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
      patch: ServerSettingsPatch,
    ): Effect.Effect<ServerSettings, ServerSettingsError> =>
      writeSemaphore.withPermits(1)(
        Ref.get(currentSettingsRef).pipe(
          Effect.flatMap((current) =>
            update(current).pipe(
              Effect.map((next) => restoreRedactedProviderSettingsSecrets(current, next, patch)),
            ),
          ),
          Effect.flatMap(normalizeServerSettings),
          Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
          Effect.map(resolveTextGenerationProvider),
        ),
      );

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings,
      updateSettings: (patch) =>
        updateTestSettings(
          (currentSettings) => Effect.succeed(applyServerSettingsPatch(currentSettings, patch)),
          patch,
        ),
      updateProviderInstance: (mutation, patch = {}) =>
        updateTestSettings(
          (currentSettings) =>
            Effect.gen(function* () {
              yield* ensureProviderInstanceMutationAllowed(
                currentSettings,
                mutation,
                "test settings",
              );
              const patched = applyServerSettingsPatch(currentSettings, patch);
              return applyProviderInstanceMutation(patched, mutation);
            }),
          patch,
        ),
      withSettingsSnapshot: (use) =>
        writeSemaphore.withPermits(1)(getSettings.pipe(Effect.flatMap(use))),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    } satisfies ServerSettingsService["Service"];
  });

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(ServerSettingsService, makeTest(overrides));

// Migrate saved token delivery without accepting it in settings writes or
// letting one retired value reset the rest of the environment's settings.
const PersistedResponseStreamingMode = Schema.Union([
  ResponseStreamingMode,
  Schema.Literal("token"),
]).pipe(
  Schema.decodeTo(
    ResponseStreamingMode,
    SchemaTransformation.transform({
      decode: (mode) => (mode === "token" ? "paragraph" : mode),
      encode: (mode) => mode,
    }),
  ),
);
const ServerSettingsJson = fromLenientJson(
  Schema.Struct({
    ...ServerSettings.fields,
    responseStreamingMode: PersistedResponseStreamingMode.pipe(
      Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
    ),
    projectSettingsOverrides: Schema.Record(
      ProjectId,
      Schema.Struct({
        ...ProjectSettingsOverrides.fields,
        responseStreamingMode: Schema.optionalKey(PersistedResponseStreamingMode),
      }),
    ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }),
);
const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(ServerSettingsJson);
const PersistedOptionalProviderSettings = Schema.Struct({
  providers: Schema.optionalKey(
    Schema.Struct({
      cursor: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
      grok: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
      opencode: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
    }),
  ),
});
const decodePersistedOptionalProviderSettingsJsonExit = Schema.decodeUnknownExit(
  fromLenientJson(PersistedOptionalProviderSettings),
);

function restoreUsedProviders(
  settings: ServerSettings,
  persisted: typeof PersistedOptionalProviderSettings.Type,
  providerHistory: ReadonlyArray<{
    readonly providerName: string;
    readonly providerInstanceId: string | null;
  }>,
): ServerSettings {
  const usedProviders = new Set(providerHistory.map(({ providerName }) => providerName));
  const usedProviderInstances = new Set(
    providerHistory.map(
      ({ providerName, providerInstanceId }) => providerInstanceId ?? providerName,
    ),
  );
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
      instanceId,
      instance.enabled === undefined &&
      (instance.driver === "cursor" ||
        instance.driver === "grok" ||
        instance.driver === "opencode") &&
      usedProviderInstances.has(instanceId)
        ? { ...instance, enabled: true }
        : instance,
    ]),
  );

  return {
    ...settings,
    providers: {
      ...settings.providers,
      cursor: {
        ...settings.providers.cursor,
        enabled: persisted.providers?.cursor?.enabled ?? usedProviders.has("cursor"),
      },
      grok: {
        ...settings.providers.grok,
        enabled: persisted.providers?.grok?.enabled ?? usedProviders.has("grok"),
      },
      opencode: {
        ...settings.providers.opencode,
        enabled: persisted.providers?.opencode?.enabled ?? usedProviders.has("opencode"),
      },
    },
    providerInstances,
  };
}

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

/** ACP Registry instances reject every application text-generation operation. */
function selectionSupportsTextGeneration(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  return settings.providerInstances[selection.instanceId]?.driver !== ACP_REGISTRY_DRIVER;
}

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  return isModelSelectionProviderEnabled(settings, settings.textGenerationModelSelection) &&
    selectionSupportsTextGeneration(settings, settings.textGenerationModelSelection)
    ? settings
    : fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  // Same precedence as isModelSelectionProviderEnabled: an explicit provider
  // instance wins over the legacy providers map, which decodes to defaults
  // (codex enabled) when the Providers UI has only written providerInstances.
  const fallbackEntry = Object.entries(settings.providers).find(([driver, provider]) => {
    const instance = settings.providerInstances[ProviderInstanceId.make(driver)];
    return instance === undefined ? provider.enabled : resolveProviderInstanceEnabled(instance);
  });
  const fallback = fallbackEntry ? ProviderDriverKind.make(fallbackEntry[0]) : undefined;
  if (!fallback) {
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make(fallback),
      model:
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_TEXT_GENERATION_MODEL,
    } satisfies ModelSelection,
  };
}

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "sourceControlWriterModelSelection",
  "textGenerationModelSelection",
  "pullRequestMergeMethod",
  // Both lists are required; stripping an empty one makes the file unwritable.
  "sidebarProjectOrder",
]);

// Preserve both enabled states because provider history cannot recover a new opt-in.
const PERSISTED_SERVER_SETTINGS_DEFAULTS = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, enabled: undefined },
    grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: undefined },
    opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: undefined },
  },
};

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const decodeProjectScriptsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);
const decodeModelSelectionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(ModelSelection)),
);

interface LegacyProjectSettingsRow {
  readonly projectId: string;
  readonly defaultModelSelection: string | null;
  readonly defaultThreadEnvMode: string | null;
  readonly autoPull: number;
  readonly scripts: string;
}

/**
 * One-time fold of the legacy per-project fields into `projectSettingsOverrides`:
 * the three `project*Overrides` maps and the settings columns on the project
 * aggregate. Keys already present in the generic record win. Marked with
 * `projectSettingsFolded` so a later reset in the UI survives restarts.
 */
function foldLegacyProjectSettings(
  settings: ServerSettings,
  rows: ReadonlyArray<LegacyProjectSettingsRow>,
): ServerSettings {
  if (settings.projectSettingsFolded) return settings;
  // Nothing to fold yet (fresh install): leave the marker off so the file
  // stays sparse, and check again on the next load.
  if (
    rows.length === 0 &&
    Object.keys(settings.projectAgentBrowserAccessOverrides).length === 0 &&
    Object.keys(settings.projectAutoPullOverrides).length === 0 &&
    Object.keys(settings.projectScriptOverrides).length === 0
  ) {
    return settings;
  }
  const entries: Record<string, ProjectSettingsOverrides> = {
    ...settings.projectSettingsOverrides,
  };
  const set = <K extends keyof ProjectSettingsOverrides>(
    projectId: string,
    key: K,
    value: ProjectSettingsOverrides[K] | undefined,
  ) => {
    if (value === undefined) return;
    const entry = entries[projectId] ?? {};
    if (Object.hasOwn(entry, key)) return;
    entries[projectId] = { ...entry, [key]: value };
  };
  for (const [projectId, value] of Object.entries(settings.projectAgentBrowserAccessOverrides)) {
    set(projectId, "enableAgentBrowserAccess", value);
  }
  for (const [projectId, value] of Object.entries(settings.projectAutoPullOverrides)) {
    set(projectId, "defaultAutoPull", value);
  }
  // A stored null meant "reset to machine defaults", which is now plain
  // inheritance; the project's own aggregate scripts must not resurface.
  const resetScripts = new Set<string>();
  for (const [projectId, value] of Object.entries(settings.projectScriptOverrides)) {
    if (value === null) resetScripts.add(projectId);
    else set(projectId, "defaultProjectScripts", value);
  }
  for (const row of rows) {
    const model = decodeModelSelectionJson(row.defaultModelSelection ?? "null");
    if (Option.isSome(model) && model.value !== null) {
      set(row.projectId, "defaultModelSelection", model.value);
    }
    if (row.defaultThreadEnvMode === "local" || row.defaultThreadEnvMode === "worktree") {
      set(row.projectId, "defaultThreadEnvMode", row.defaultThreadEnvMode);
    }
    if (row.autoPull === 1) set(row.projectId, "defaultAutoPull", true);
    const scripts = decodeProjectScriptsJson(row.scripts);
    if (Option.isSome(scripts) && scripts.value.length > 0 && !resetScripts.has(row.projectId)) {
      set(row.projectId, "defaultProjectScripts", scripts.value);
    }
  }
  const projectSettingsOverrides = Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => Object.keys(entry).length > 0),
  );
  return {
    ...settings,
    projectSettingsOverrides,
    projectSettingsFolded: true,
    ...deriveLegacyProjectOverrides({ projectSettingsOverrides }),
  };
}

const make = Effect.gen(function* () {
  const { settingsPath, stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "check-exists",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
    ),
  );

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        stripDefaultServerSettings(settings, PERSISTED_SERVER_SETTINGS_DEFAULTS) ?? {},
      );

      return yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: `${sparseSettingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  /**
   * Moves Bitbucket tokens hand-edited into settings.json into the secret store as they load,
   * so plaintext does not stay on disk. If the store is unavailable, the token keeps working
   * from the file and the move is retried on the next load.
   */
  const moveInlineBitbucketTokens = (settings: ServerSettings) =>
    Effect.gen(function* () {
      const bitbucket = { ...settings.bitbucket };
      let moved = false;
      for (const field of BITBUCKET_SECRET_FIELDS) {
        const value = bitbucket[field];
        if (value.length === 0 || value === SECRET_REDACTED) continue;
        const stored = yield* secretStore
          .set(BITBUCKET_SECRET_NAMES[field], textEncoder.encode(value))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move a Bitbucket token into the secret store", {
                field,
              }).pipe(Effect.as(false)),
            ),
          );
        if (!stored) continue;
        bitbucket[field] = SECRET_REDACTED;
        moved = true;
      }
      const tokens = { ...settings.github.tokens };
      for (const [host, value] of Object.entries(tokens)) {
        if (value.length === 0 || value === SECRET_REDACTED) continue;
        const stored = yield* secretStore
          .set(gitHubTokenSecretName(host), textEncoder.encode(value))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move a GitHub token into the secret store", {
                host,
              }).pipe(Effect.as(false)),
            ),
          );
        if (!stored) continue;
        tokens[host] = SECRET_REDACTED;
        moved = true;
      }
      const voice = { ...settings.voice };
      const voiceKey = voice.elevenLabsApiKey;
      if (voiceKey.length > 0 && voiceKey !== SECRET_REDACTED) {
        const stored = yield* secretStore
          .set(ELEVENLABS_VOICE_SECRET_NAME, textEncoder.encode(voiceKey))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move the ElevenLabs key into the secret store").pipe(
                Effect.as(false),
              ),
            ),
          );
        if (stored) {
          voice.elevenLabsApiKey = SECRET_REDACTED;
          moved = true;
        }
      }
      return moved
        ? { ...settings, bitbucket, github: { ...settings.github, tokens }, voice }
        : settings;
    });

  const loadSettingsFromDisk = Effect.gen(function* () {
    let settings = DEFAULT_SERVER_SETTINGS;
    let persisted: typeof PersistedOptionalProviderSettings.Type = {};
    // A file that failed to decode must stay on disk for the user to repair;
    // the fold below only writes when it started from the file's real contents.
    let settingsFileTrusted = true;

    if (yield* readConfigExists) {
      const raw = yield* readRawConfig;
      const decoded = decodeServerSettingsJsonExit(raw);
      const persistedSettings = decodePersistedOptionalProviderSettingsJsonExit(raw);
      if (persistedSettings._tag === "Success") {
        persisted = persistedSettings.value;
      }
      if (decoded._tag === "Failure" || persistedSettings._tag === "Failure") {
        const failure = decoded._tag === "Failure" ? decoded : persistedSettings;
        settingsFileTrusted = false;
        if (failure._tag === "Failure") {
          yield* Effect.logWarning("failed to parse settings.json, using defaults", {
            path: settingsPath,
            issues: Cause.pretty(failure.cause),
            cause: failure.cause,
          });
        }
      } else {
        settings = decoded.value;
      }
    }

    const providerHistory = yield* sql<{
      readonly providerName: string;
      readonly providerInstanceId: string | null;
    }>`
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM projection_thread_sessions
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
      UNION
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM provider_session_runtime
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-provider-history",
            cause,
          }),
      ),
    );

    const legacyProjectRows =
      settings.projectSettingsFolded || !settingsFileTrusted
        ? []
        : yield* sql<LegacyProjectSettingsRow>`
          SELECT
            project_id AS "projectId",
            default_model_selection_json AS "defaultModelSelection",
            default_thread_env_mode AS "defaultThreadEnvMode",
            auto_pull AS "autoPull",
            scripts_json AS "scripts"
          FROM projection_projects
          WHERE deleted_at IS NULL
        `.pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-project-settings",
                  cause,
                }),
            ),
          );

    const loaded = foldProviderInstanceEnabledFlags(
      restoreUsedProviders(settings, persisted, providerHistory),
    );
    const folded = settingsFileTrusted
      ? foldLegacyProjectSettings(loaded, legacyProjectRows)
      : loaded;
    const liveProjectIds =
      folded.projectSettingsSimplified ||
      !settingsFileTrusted ||
      Object.keys(folded.projectSettingsOverrides).length === 0
        ? []
        : (yield* sql<{ readonly projectId: string }>`
            SELECT project_id AS "projectId"
            FROM projection_projects
            WHERE deleted_at IS NULL
          `.pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-project-settings",
                  cause,
                }),
            ),
          )).map((row) => row.projectId);
    // Fresh installs with no overrides stay sparse and are checked again next load.
    const simplified =
      settingsFileTrusted && Object.keys(folded.projectSettingsOverrides).length > 0
        ? simplifyProjectSettingsOverrides(folded, liveProjectIds)
        : folded;
    // Only rewrite a file that decoded cleanly; an untrusted one stays for the user to repair.
    const migrated = settingsFileTrusted
      ? yield* moveInlineBitbucketTokens(simplified)
      : simplified;
    if (migrated !== loaded) {
      yield* writeSettingsAtomically(migrated);
    }
    return migrated;
  });

  // A failed read is not kept: the next read retries instead of replaying the failure.
  const settingsCache = yield* Cache.makeWith<typeof cacheKey, ServerSettings, ServerSettingsError>(
    () => loadSettingsFromDisk,
    {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const materializeProviderEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          if (!variable.sensitive || !variable.valueRedacted) {
            environment.push(variable);
            continue;
          }
          const secret = yield* secretStore
            .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "read-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
          environment.push({
            ...variable,
            value: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
          });
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }
      const usageLimitSources: Record<string, UsageLimitSourceConfig> = {};
      for (const [sourceId, source] of Object.entries(settings.usageLimitSources)) {
        if (source.managementKey !== SECRET_REDACTED) {
          usageLimitSources[sourceId] = source;
          continue;
        }
        const secret = yield* secretStore
          .get(usageLimitSourceSecretName(sourceId))
          .pipe(
            Effect.mapError(
              (cause) => new ServerSettingsError({ settingsPath, operation: "read-secret", cause }),
            ),
          );
        usageLimitSources[sourceId] = {
          ...source,
          managementKey: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
        };
      }
      const bitbucket = { ...settings.bitbucket };
      for (const field of BITBUCKET_SECRET_FIELDS) {
        if (bitbucket[field] !== SECRET_REDACTED) continue;
        const secret = yield* secretStore
          .get(BITBUCKET_SECRET_NAMES[field])
          .pipe(
            Effect.mapError(
              (cause) => new ServerSettingsError({ settingsPath, operation: "read-secret", cause }),
            ),
          );
        bitbucket[field] = Option.isSome(secret) ? textDecoder.decode(secret.value) : "";
      }
      const tokens: Record<string, string> = {};
      for (const [host, value] of Object.entries(settings.github.tokens)) {
        if (value !== SECRET_REDACTED) {
          tokens[host] = value;
          continue;
        }
        const secret = yield* secretStore
          .get(gitHubTokenSecretName(host))
          .pipe(
            Effect.mapError(
              (cause) => new ServerSettingsError({ settingsPath, operation: "read-secret", cause }),
            ),
          );
        tokens[host] = Option.isSome(secret) ? textDecoder.decode(secret.value) : "";
      }
      const voice = { ...settings.voice };
      if (voice.elevenLabsApiKey === SECRET_REDACTED) {
        const secret = yield* secretStore
          .get(ELEVENLABS_VOICE_SECRET_NAME)
          .pipe(
            Effect.mapError(
              (cause) => new ServerSettingsError({ settingsPath, operation: "read-secret", cause }),
            ),
          );
        voice.elevenLabsApiKey = Option.isSome(secret) ? textDecoder.decode(secret.value) : "";
      }
      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
        usageLimitSources: usageLimitSources as ServerSettings["usageLimitSources"],
        bitbucket,
        github: { ...settings.github, tokens },
        voice,
      };
    });

  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeProviderEnvironmentSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize provider environment secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(resolveTextGenerationProvider),
    );

  type SecretChange = {
    readonly secretName: string;
    readonly providerInstanceId?: string;
    readonly environmentVariable?: string;
  } & (
    | { readonly kind: "write"; readonly value: Uint8Array }
    | { readonly kind: "remove"; readonly operation: "remove-secret" | "remove-stale-secret" }
  );

  const persistProviderEnvironmentSecrets = (current: ServerSettings, next: ServerSettings) =>
    Effect.sync(() => {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };
      const changes: SecretChange[] = [];

      const nextSecretKeys = new Set<string>();
      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (!variable.sensitive) {
            changes.push({
              kind: "remove",
              secretName,
              operation: "remove-secret",
              providerInstanceId: instanceId,
              environmentVariable: variable.name,
            });
            environment.push(redactProviderEnvironmentVariable(variable));
            continue;
          }

          nextSecretKeys.add(secretName);
          // Match the provider environment's last-value-wins behavior for duplicate names.
          const previous = variable.valueRedacted
            ? current.providerInstances[ProviderInstanceId.make(instanceId)]?.environment?.findLast(
                (entry) => entry.name === variable.name,
              )
            : undefined;
          const inlineValue =
            previous?.sensitive && !previous.valueRedacted && previous.value.length > 0
              ? previous.value
              : undefined;
          const value = inlineValue ?? variable.value;
          if (!variable.valueRedacted || inlineValue !== undefined) {
            if (value.length > 0) {
              changes.push({
                kind: "write",
                secretName,
                value: textEncoder.encode(value),
                providerInstanceId: instanceId,
                environmentVariable: variable.name,
              });
              environment.push({ ...variable, value: "", valueRedacted: true });
            } else {
              changes.push({
                kind: "remove",
                secretName,
                operation: "remove-secret",
                providerInstanceId: instanceId,
                environmentVariable: variable.name,
              });
              const { valueRedacted: _omit, ...rest } = variable;
              environment.push(rest);
            }
            continue;
          }

          environment.push(redactProviderEnvironmentVariable(variable));
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        for (const variable of instance.environment ?? []) {
          if (!variable.sensitive) continue;
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (nextSecretKeys.has(secretName)) continue;
          changes.push({
            kind: "remove",
            secretName,
            operation: "remove-stale-secret",
            providerInstanceId: instanceId,
            environmentVariable: variable.name,
          });
        }
      }

      const usageLimitSources: Record<string, UsageLimitSourceConfig> = {};
      for (const [sourceId, source] of Object.entries(next.usageLimitSources)) {
        const secretName = usageLimitSourceSecretName(sourceId);
        if (source.managementKey === SECRET_REDACTED) {
          // The key unlocks every pooled account, so it never follows the source to a
          // new origin: moving the URL drops it until the user enters it again.
          const previous = current.usageLimitSources[sourceId as UsageLimitSourceId];
          if (previous && sameUrlOrigin(previous.url, source.url)) {
            usageLimitSources[sourceId] = source;
            continue;
          }
          changes.push({ kind: "remove", secretName, operation: "remove-secret" });
          usageLimitSources[sourceId] = { ...source, managementKey: "" };
          continue;
        }
        if (source.managementKey.length === 0) {
          changes.push({ kind: "remove", secretName, operation: "remove-secret" });
          usageLimitSources[sourceId] = source;
          continue;
        }
        changes.push({
          kind: "write",
          secretName,
          value: textEncoder.encode(source.managementKey),
        });
        usageLimitSources[sourceId] = { ...source, managementKey: SECRET_REDACTED };
      }
      for (const sourceId of Object.keys(current.usageLimitSources)) {
        if (sourceId in next.usageLimitSources) continue;
        changes.push({
          kind: "remove",
          secretName: usageLimitSourceSecretName(sourceId),
          operation: "remove-stale-secret",
        });
      }

      const bitbucket = { ...next.bitbucket };
      for (const field of BITBUCKET_SECRET_FIELDS) {
        let value = bitbucket[field];
        if (value === SECRET_REDACTED) {
          // The marker keeps what is saved. A plaintext value hand-edited into settings.json
          // is not in the secret store yet, so move it there instead of dropping it.
          const inline = current.bitbucket[field];
          if (inline === SECRET_REDACTED || inline.length === 0) continue;
          value = inline;
        }
        const secretName = BITBUCKET_SECRET_NAMES[field];
        if (value.length === 0) {
          changes.push({ kind: "remove", secretName, operation: "remove-secret" });
          continue;
        }
        changes.push({ kind: "write", secretName, value: textEncoder.encode(value) });
        bitbucket[field] = SECRET_REDACTED;
      }

      const tokens: Record<string, string> = {};
      for (const [rawHost, raw] of Object.entries(next.github.tokens)) {
        const host = rawHost.trim().toLowerCase();
        let value = raw;
        if (value === SECRET_REDACTED) {
          // The marker keeps what is saved; a hand-edited plaintext token moves into the store.
          const inline = current.github.tokens[host];
          if (inline === undefined || inline === SECRET_REDACTED || inline.length === 0) {
            tokens[host] = SECRET_REDACTED;
            continue;
          }
          value = inline;
        }
        const secretName = gitHubTokenSecretName(host);
        if (value.length === 0) {
          changes.push({ kind: "remove", secretName, operation: "remove-secret" });
          continue;
        }
        changes.push({ kind: "write", secretName, value: textEncoder.encode(value) });
        tokens[host] = SECRET_REDACTED;
      }
      const nextHosts = new Set(
        Object.keys(next.github.tokens).map((host) => host.trim().toLowerCase()),
      );
      for (const host of Object.keys(current.github.tokens)) {
        if (nextHosts.has(host.trim().toLowerCase())) continue;
        changes.push({
          kind: "remove",
          secretName: gitHubTokenSecretName(host),
          operation: "remove-stale-secret",
        });
      }

      const voice = { ...next.voice };
      {
        let value = voice.elevenLabsApiKey;
        if (value === SECRET_REDACTED) {
          // The marker keeps what is saved; a hand-edited plaintext key moves into the store.
          const inline = current.voice.elevenLabsApiKey;
          value = inline === SECRET_REDACTED ? "" : inline;
        }
        if (value.length > 0) {
          changes.push({
            kind: "write",
            secretName: ELEVENLABS_VOICE_SECRET_NAME,
            value: textEncoder.encode(value),
          });
          voice.elevenLabsApiKey = SECRET_REDACTED;
        } else if (voice.elevenLabsApiKey !== SECRET_REDACTED) {
          changes.push({
            kind: "remove",
            secretName: ELEVENLABS_VOICE_SECRET_NAME,
            operation: "remove-secret",
          });
        }
      }

      return {
        settings: {
          ...next,
          providerInstances: providerInstances as ServerSettings["providerInstances"],
          usageLimitSources: usageLimitSources as ServerSettings["usageLimitSources"],
          bitbucket,
          github: { ...next.github, tokens },
          voice,
        },
        changes,
      };
    });

  const rollbackProviderEnvironmentSecretWrites = (
    writes: ReadonlyArray<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }>,
  ) =>
    Effect.forEach(
      writes.toReversed(),
      (write) =>
        (Option.isSome(write.previousValue)
          ? secretStore.set(write.secretName, write.previousValue.value)
          : secretStore.remove(write.secretName)
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to roll back provider environment secret", {
              providerInstanceId: write.providerInstanceId,
              environmentVariable: write.environmentVariable,
              cause,
            }),
          ),
        ),
      { discard: true },
    );

  const applyProviderEnvironmentSecretChanges = (changes: ReadonlyArray<SecretChange>) => {
    const applied: Array<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }> = [];
    const rollback = Effect.suspend(() => rollbackProviderEnvironmentSecretWrites(applied));
    return Effect.forEach(
      changes,
      (change) =>
        Effect.gen(function* () {
          const previousValue = yield* secretStore.get(change.secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-secret",
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
          // A store operation may mutate before reporting an error (for example chmod after rename).
          applied.push({ ...change, previousValue });
          yield* (
            change.kind === "write"
              ? secretStore.set(change.secretName, change.value)
              : secretStore.remove(change.secretName)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: change.kind === "write" ? "write-secret" : change.operation,
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
        }),
      { discard: true },
    ).pipe(
      Effect.tapError(() => rollback),
      Effect.as(rollback),
    );
  };

  const removeInstanceSignIn = ({ driver, instanceId }: InstanceSignIn) =>
    Effect.gen(function* () {
      if (driver === "antigravity") {
        return yield* removeAntigravityInstanceProfile(stateDir, instanceId);
      }
      return yield* ProviderCredentialStore.removeInstanceCredentials(driver, instanceId);
    }).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
    );

  const tombstonesPath = pathService.join(stateDir, SIGN_IN_TOMBSTONES_FILE);
  const tombstonesSemaphore = yield* Semaphore.make(1);

  const readSignInTombstones = Effect.gen(function* () {
    if (!(yield* fs.exists(tombstonesPath))) return {} as SignInTombstones;
    const parsed = decodeSignInTombstones(yield* fs.readFileString(tombstonesPath));
    if (Option.isNone(parsed)) {
      yield* Effect.logWarning("Ignoring an unreadable provider sign-in tombstone file");
      return {} as SignInTombstones;
    }
    return parsed.value as SignInTombstones;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({ settingsPath: tombstonesPath, operation: "read-secret", cause }),
    ),
  );

  /**
   * Tombstones for a decision that only skips work when the file is gone: a
   * file that cannot be read (EACCES, EISDIR...) must not fail every settings
   * write, so it counts as empty. Recording a tombstone stays strict.
   */
  const readSignInTombstonesOrEmpty = tombstonesSemaphore
    .withPermits(1)(readSignInTombstones)
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not read provider sign-in tombstones", error).pipe(
          Effect.as({} as SignInTombstones),
        ),
      ),
    );

  /** Replaces the tombstone file with `tombstones`. Callers hold `tombstonesSemaphore`. */
  const writeSignInTombstones = (tombstones: SignInTombstones, instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      if (Object.keys(tombstones).length === 0) {
        yield* fs.remove(tombstonesPath, { force: true });
        return;
      }
      yield* writeFileStringAtomically({
        filePath: tombstonesPath,
        contents: `${yield* encodeSignInTombstones(tombstones)}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath: tombstonesPath,
            operation: "write-secret",
            providerInstanceId: instanceId,
            cause,
          }),
      ),
    );

  const updateSignInTombstone = (signIn: InstanceSignIn, state: SignInTombstoneState) =>
    tombstonesSemaphore.withPermits(1)(
      readSignInTombstones.pipe(
        Effect.flatMap((tombstones) =>
          writeSignInTombstones(withSignInTombstone(tombstones, signIn, state), signIn.instanceId),
        ),
      ),
    );

  /**
   * Records the tombstone of an explicit remove. A tombstone file that cannot
   * be read must not make every instance undeletable: it is replaced by one
   * holding only this tombstone (losing the others it may have held). When
   * even that fails (the path is a directory, say) the remove still goes
   * ahead untracked: false tells the caller to delete the sign-in at once,
   * as a best effort without a retry.
   */
  const recordRemovedSignIn = (removed: InstanceSignIn) =>
    updateSignInTombstone(removed, "removed").pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Replacing an unusable provider sign-in tombstone file", error);
          return yield* tombstonesSemaphore
            .withPermits(1)(
              writeSignInTombstones(
                withSignInTombstone({}, removed, "removed"),
                removed.instanceId,
              ),
            )
            .pipe(
              Effect.as(true),
              Effect.catch((replaceError) =>
                Effect.logWarning(
                  "Could not record a removed provider instance; deleting its sign-in once now",
                  replaceError,
                ).pipe(Effect.as(false)),
              ),
            );
        }),
      ),
    );

  const persistSettingsUpdate = (
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
    patch: ServerSettingsPatch,
    mutation: ProviderInstanceMutation | undefined,
  ) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* getSettingsFromCache;
        const updated = restoreRedactedProviderSettingsSecrets(
          current,
          yield* update(current),
          patch,
        );
        const tombstones = yield* readSignInTombstonesOrEmpty;
        const { clear: leftovers, stale } = classifySignInTombstones(current, updated, tombstones);
        // Cleared outside the settings lock: Codex removal waits on its sign-in lock.
        if (leftovers.length > 0) return { _tag: "clear" as const, leftovers };
        const persisted = yield* persistProviderEnvironmentSecrets(current, updated);
        const next = yield* normalizeServerSettings(persisted.settings);
        const removedInstance =
          mutation?.operation === "remove"
            ? ownEntry(current.providerInstances, mutation.instanceId)
            : undefined;
        // Only an explicit remove deletes a sign-in. A whole-map write can come
        // from a client that has not seen an instance created elsewhere yet.
        const removed: InstanceSignIn | undefined =
          mutation !== undefined &&
          removedInstance !== undefined &&
          (mutation.instanceId as string) !== removedInstance.driver &&
          ownEntry(next.providerInstances, mutation.instanceId) === undefined
            ? { driver: removedInstance.driver as string, instanceId: mutation.instanceId }
            : undefined;
        // Recorded before the instance disappears, so a cleanup that fails or
        // never runs is still done before the id is used again.
        const tracked = removed === undefined ? false : yield* recordRemovedSignIn(removed);
        const dropUnusedTombstone =
          removed === undefined || !tracked || hasSignInTombstone(tombstones, removed)
            ? Effect.void
            : updateSignInTombstone(removed, "gone").pipe(Effect.ignore({ log: true }));
        const materialized = yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const rollbackSecretChanges = yield* applyProviderEnvironmentSecretChanges(
              persisted.changes,
            ).pipe(Effect.tapError(() => dropUnusedTombstone));
            const materializedExit = yield* Effect.exit(
              materializeProviderEnvironmentSecrets(next),
            );
            if (Exit.isFailure(materializedExit)) {
              yield* rollbackSecretChanges;
              yield* dropUnusedTombstone;
              return yield* Effect.failCause(materializedExit.cause);
            }
            const writeExit = yield* Effect.exit(writeSettingsAtomically(next));
            if (Exit.isFailure(writeExit)) {
              yield* rollbackSecretChanges;
              yield* dropUnusedTombstone;
              return yield* Effect.failCause(writeExit.cause);
            }
            return materializedExit.value;
          }),
        );
        yield* Cache.set(settingsCache, cacheKey, next);
        yield* emitChange(next);
        // The instance outlived its tombstone: keep its sign-in, drop the tombstone.
        yield* Effect.forEach(
          stale,
          (signIn) => updateSignInTombstone(signIn, "gone").pipe(Effect.ignore({ log: true })),
          { discard: true },
        );
        return {
          _tag: "saved" as const,
          saved: resolveTextGenerationProvider(materialized),
          removed: removed === undefined ? undefined : { ...removed, tracked },
        };
      }),
    );

  /**
   * Deletes a tombstoned sign-in, then moves its tombstone to `after` (or
   * leaves it). Every deletion runs under `signInCleanupSemaphore`, outside
   * the settings lock (Codex removal can wait on its sign-in lock), so a write
   * that adds the id back waits for a deletion in progress instead of racing it.
   */
  const deleteTombstonedSignIn = (signIn: InstanceSignIn, after?: SignInTombstoneState) =>
    removeInstanceSignIn(signIn).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "remove-secret",
            providerInstanceId: signIn.instanceId,
            cause,
          }),
      ),
      Effect.andThen(after === undefined ? Effect.void : updateSignInTombstone(signIn, after)),
    );

  const signInCleanupSemaphore = yield* Semaphore.make(1);

  /**
   * Deletes the sign-ins of removed instances the provider registry no longer
   * runs, then their tombstones. Until the registry has disposed a removed
   * instance, its driver can still write (a Cursor token refresh, an OAuth
   * completion, a gemini login recreating GEMINI_HOME), so the tombstone stays.
   * Never touches an instance that is live in settings: that tombstone is
   * stale and only it is dropped. Entries already `readded` are left to
   * `clearSignInsBeforeStart`.
   */
  const clearRemovedInstanceSignIns = (runningInstanceIds: Iterable<string>) => {
    const running = new Set(runningInstanceIds);
    return signInCleanupSemaphore
      .withPermits(1)(
        Effect.gen(function* () {
          // Runs after every reconcile: nothing to do is the common case.
          const pending = yield* tombstonesSemaphore.withPermits(1)(readSignInTombstones);
          if (Object.keys(pending).length === 0) return;
          // Read under the settings lock so a remove in progress is either
          // fully saved (tombstone and settings) or not seen at all.
          const { settings, tombstones } = yield* writeSemaphore.withPermits(1)(
            Effect.all({
              settings: getSettingsFromCache,
              tombstones: tombstonesSemaphore.withPermits(1)(readSignInTombstones),
            }),
          );
          for (const [instanceId, entries] of Object.entries(tombstones)) {
            if (running.has(instanceId)) continue;
            const live = ownEntry(settings.providerInstances, instanceId);
            for (const { driver, readded } of entries) {
              if (readded === true) continue;
              const signIn = { driver, instanceId: instanceId as ProviderInstanceId };
              yield* (
                live?.driver === driver
                  ? updateSignInTombstone(signIn, "gone")
                  : deleteTombstonedSignIn(signIn, "gone")
              ).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    "Could not remove a deleted provider instance's sign-in",
                    error,
                  ),
                ),
              );
            }
          }
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not read removed provider instance sign-ins", error),
        ),
      );
  };

  /**
   * Called by the provider registry just before it starts `instanceIds`, after
   * it disposed whatever ran under those ids before. Deletes the sign-in a
   * removed instance of the same id may have written while shutting down
   * (entries a write marked `readded`), then drops the tombstone. Returns the
   * ids whose sign-in could not be deleted: those must not start yet.
   */
  const clearSignInsBeforeStart = (instanceIds: Iterable<string>) =>
    signInCleanupSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const blocked = new Set<string>();
        const tombstones = yield* readSignInTombstonesOrEmpty;
        for (const instanceId of instanceIds) {
          for (const { driver, readded } of ownEntry(tombstones, instanceId) ?? []) {
            if (readded !== true) continue;
            const signIn = { driver, instanceId: instanceId as ProviderInstanceId };
            yield* deleteTombstonedSignIn(signIn, "gone").pipe(
              Effect.catch((error) => {
                blocked.add(instanceId);
                return Effect.logWarning(
                  "Could not clear a re-added provider instance's old sign-in",
                  error,
                );
              }),
            );
          }
        }
        return blocked as ReadonlySet<string>;
      }),
    );

  const instancesAwaitingSignInClear = (instanceIds: Iterable<string>) =>
    readSignInTombstonesOrEmpty.pipe(
      Effect.map(
        (tombstones): ReadonlySet<string> =>
          new Set(
            [...instanceIds].filter((instanceId) =>
              (ownEntry(tombstones, instanceId) ?? []).some(({ readded }) => readded === true),
            ),
          ),
      ),
    );

  const updateAndPersistSettings = (
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
    patch: ServerSettingsPatch,
    mutation?: ProviderInstanceMutation,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      for (let attempt = 1; ; attempt++) {
        const result = yield* persistSettingsUpdate(update, patch, mutation);
        if (result._tag === "clear") {
          // A new instance must not start with the sign-in a removed one of the
          // same id left behind: the write fails unless the leftovers are gone.
          // The tombstone stays, marked `readded`: the removed instance's driver
          // may not be disposed yet, so the registry clears once more before it
          // starts the new one (`clearSignInsBeforeStart`).
          yield* signInCleanupSemaphore.withPermits(1)(
            Effect.forEach(
              result.leftovers,
              (signIn) => deleteTombstonedSignIn(signIn, "readded"),
              { discard: true },
            ),
          );
          if (attempt < 3) continue;
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "remove-secret",
            providerInstanceId: result.leftovers[0]?.instanceId,
          });
        }
        const removed = result.removed;
        if (removed !== undefined && !removed.tracked) {
          yield* signInCleanupSemaphore
            .withPermits(1)(deleteTombstonedSignIn(removed))
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not remove a deleted provider instance's sign-in", error),
              ),
            );
        } else if (removed !== undefined) {
          // Delete now, but keep the tombstone: the registry disposes the
          // instance's driver later, and `clearRemovedInstanceSignIns` deletes
          // again after that and only then drops it.
          yield* signInCleanupSemaphore
            .withPermits(1)(
              Effect.gen(function* () {
                const tombstones = yield* tombstonesSemaphore.withPermits(1)(readSignInTombstones);
                // Already cleared and dropped before the id started again.
                if (!hasSignInTombstone(tombstones, removed)) return;
                yield* deleteTombstonedSignIn(removed);
              }),
            )
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not remove a deleted provider instance's sign-in", error),
              ),
            );
        }
        return result.saved;
      }
    });

  const withSettingsSnapshot: ServerSettingsService["Service"]["withSettingsSnapshot"] = (use) =>
    writeSemaphore.withPermits(1)(
      getSettingsFromCache.pipe(
        Effect.flatMap(materializeProviderEnvironmentSecrets),
        Effect.map(resolveTextGenerationProvider),
        Effect.flatMap(use),
      ),
    );

  // An edit to settings.json never deletes or clears a sign-in.
  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const watchFileChanges = (filePath: string) => {
    const directory = pathService.dirname(filePath);
    const fileName = pathService.basename(filePath);
    const resolvedFilePath = pathService.resolve(filePath);
    return fs
      .watch(directory)
      .pipe(
        Stream.filter(
          (event) =>
            event.path === fileName ||
            event.path === filePath ||
            pathService.resolve(directory, event.path) === resolvedFilePath,
        ),
      );
  };

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // A symlinked settings file is rewritten in its destination's directory,
    // which a watch on the link's directory never sees. The link is resolved
    // again whenever it changes, so repointing it moves the watch along.
    const watchLinkTarget = Effect.gen(function* () {
      const linkTargetPath = yield* resolveSymlinkTarget(settingsPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
      if (linkTargetPath === pathService.resolve(settingsPath)) {
        return Option.none<string>();
      }
      yield* fs
        .makeDirectory(pathService.dirname(linkTargetPath), { recursive: true })
        .pipe(Effect.ignore({ log: true }));
      return Option.some(linkTargetPath);
    }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

    const initialLinkTarget = yield* watchLinkTarget;
    const linkTargetEvents = Stream.make(initialLinkTarget).pipe(
      Stream.concat(watchFileChanges(settingsPath).pipe(Stream.mapEffect(() => watchLinkTarget))),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.empty,
          onSome: (linkTargetPath) =>
            watchFileChanges(linkTargetPath).pipe(Stream.ignore({ log: true })),
        }),
      ),
    );

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = Stream.merge(
      watchFileChanges(settingsPath),
      linkTargetEvents,
    ).pipe(Stream.debounce(Duration.millis(100)));

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeProviderEnvironmentSecrets),
      Effect.map(resolveTextGenerationProvider),
    ),
    updateSettings: (patch) =>
      updateAndPersistSettings(
        (current) => Effect.succeed(applyServerSettingsPatch(current, patch)),
        patch,
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateAndPersistSettings(
        (current) =>
          Effect.gen(function* () {
            yield* ensureProviderInstanceMutationAllowed(current, mutation, settingsPath);
            const patched = applyServerSettingsPatch(current, patch);
            return applyProviderInstanceMutation(patched, mutation);
          }),
        patch,
        mutation,
      ),
    withSettingsSnapshot,
    clearRemovedInstanceSignIns,
    clearSignInsBeforeStart,
    instancesAwaitingSignInClear,
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(
        Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
      );
    },
  } satisfies ServerSettingsService["Service"];
});

export const layer = Layer.effect(ServerSettingsService, make);
