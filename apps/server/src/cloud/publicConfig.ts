import {
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  DEFAULT_HOSTED_APP_URL,
} from "@specweave-studio/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@specweave-studio/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@specweave-studio/shared/relayUrl";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __STUDIO_BUILD_RELAY_URL__: string | undefined;
declare const __STUDIO_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;
declare const __STUDIO_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: string | undefined;
declare const __STUDIO_BUILD_ENABLE_HOSTED_SERVICES__: string | undefined;
declare const __STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function validateRelayUrl(value: string) {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const buildTimeRelayUrl =
  typeof __STUDIO_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__STUDIO_BUILD_RELAY_URL__) ?? "");
const buildTimeClerkPublishableKey = readBuildTimeValue(
  typeof __STUDIO_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __STUDIO_BUILD_CLERK_PUBLISHABLE_KEY__,
);
const buildTimeClerkCliOAuthClientId = readBuildTimeValue(
  typeof __STUDIO_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __STUDIO_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__,
);
const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  const tracesUrl = env.STUDIO_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.STUDIO_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.STUDIO_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.NonEmptyString("STUDIO_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapEffect(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

/**
 * Hosted app origin used for out-of-band OAuth on headless
 * machines. Overridable so staging/nightly builds can point their CLIs at a
 * matching hosted deployment.
 */
export const hostedAppUrlConfig = makePublicValueConfig(
  "STUDIO_HOSTED_APP_URL",
  DEFAULT_HOSTED_APP_URL,
).pipe(Config.mapEffect(validateHostedAppUrl));

function validateHostedAppUrl(value: string) {
  try {
    const url = new URL(value);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid hosted app origin");
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({
            message: "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
          }),
        ),
      ),
    );
  }
}

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.NonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

/**
 * The CLI never calls Clerk's /oauth/authorize itself: the browser leg goes
 * through the hosted /connect page, which builds the authorize URL after a
 * Clerk session exists (see CliTokenManager.login). The token endpoint and,
 * for headless hosts, the device authorization endpoint are contacted
 * directly.
 */
export interface CloudCliOAuthConfig {
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig({
  clerkPublishableKeyFallback = buildTimeClerkPublishableKey,
  clerkCliOAuthClientIdFallback = buildTimeClerkCliOAuthClientId,
}: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
} = {}) {
  return Config.all({
    clerkPublishableKey: makePublicValueConfig(
      "STUDIO_CLERK_PUBLISHABLE_KEY",
      clerkPublishableKeyFallback,
    ),
    clientId: makePublicValueConfig(
      "STUDIO_CLERK_CLI_OAUTH_CLIENT_ID",
      clerkCliOAuthClientIdFallback,
    ),
  }).pipe(
    Config.mapEffect(({ clerkPublishableKey, clientId }) =>
      Effect.try({
        try: () => clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey),
        catch: (cause) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Failed to derive Clerk Frontend API URL from the publishable key.",
              cause,
            }),
          ),
      }).pipe(
        Effect.map(
          (clerkFrontendApiUrl) =>
            ({
              tokenEndpoint: `${clerkFrontendApiUrl}/oauth/token`,
              deviceAuthorizationEndpoint: `${clerkFrontendApiUrl}/oauth/device_authorization`,
              clientId,
              loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
              redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
              scopes: CLOUD_CLI_OAUTH_SCOPES,
            }) satisfies CloudCliOAuthConfig,
        ),
      ),
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

/**
 * Hosted services stay off unless someone opts in: either the process sets
 * STUDIO_ENABLE_HOSTED_SERVICES=true, or the release that built this bundle
 * opted in at build time (it only does so when every Connect public value was
 * supplied). Installed launchers predate the build-time opt-in and pass
 * STUDIO_ENABLE_HOSTED_SERVICES=false, so a built-in opt-in is turned off only
 * by STUDIO_DISABLE_HOSTED_SERVICES=true.
 */
export function resolveHostedServicesEnabled(input: {
  readonly enable: string | undefined;
  readonly disable: string | undefined;
  readonly buildDefault: string | undefined;
}): boolean {
  if (input.disable?.trim() === "true") return false;
  return input.enable === "true" || input.buildDefault?.trim() === "true";
}

const hostedServicesEnabled = resolveHostedServicesEnabled({
  enable: process.env.STUDIO_ENABLE_HOSTED_SERVICES,
  disable: process.env.STUDIO_DISABLE_HOSTED_SERVICES,
  buildDefault:
    typeof __STUDIO_BUILD_ENABLE_HOSTED_SERVICES__ === "undefined"
      ? undefined
      : __STUDIO_BUILD_ENABLE_HOSTED_SERVICES__,
});

export const hasCloudPublicConfig =
  hostedServicesEnabled &&
  Boolean(
    (normalizeSecureRelayUrl(process.env.STUDIO_RELAY_URL ?? "") ?? buildTimeRelayUrl) &&
    (process.env.STUDIO_CLERK_PUBLISHABLE_KEY?.trim() || buildTimeClerkPublishableKey) &&
    (process.env.STUDIO_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || buildTimeClerkCliOAuthClientId),
  );
