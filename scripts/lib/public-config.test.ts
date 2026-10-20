// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  loadRepoEnv,
  resolveBuildHostedServicesOptIn,
  resolvePublicConfig,
} from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("does not project cloud configuration for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.STUDIO_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.STUDIO_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.STUDIO_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.STUDIO_RELAY_URL).toBeUndefined();
    expect(env.VITE_STUDIO_RELAY_URL).toBeUndefined();
    expect(env.STUDIO_MOBILE_OTLP_TRACES_URL).toBeUndefined();
    expect(env.STUDIO_MOBILE_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.STUDIO_MOBILE_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.STUDIO_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(env.STUDIO_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.STUDIO_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "STUDIO_CLERK_PUBLISHABLE_KEY=pk_root\nSTUDIO_CLERK_JWT_TEMPLATE=template_root\nSTUDIO_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nSTUDIO_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "STUDIO_CLERK_PUBLISHABLE_KEY=pk_local\nSTUDIO_CLERK_JWT_TEMPLATE=template_local\nSTUDIO_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nSTUDIO_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).STUDIO_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          STUDIO_CLERK_PUBLISHABLE_KEY: "pk_ci",
          STUDIO_CLERK_JWT_TEMPLATE: "template_ci",
          STUDIO_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          STUDIO_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      STUDIO_CLERK_PUBLISHABLE_KEY: "pk_ci",
      STUDIO_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      STUDIO_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      STUDIO_RELAY_URL: "https://ci.example.test",
      VITE_STUDIO_RELAY_URL: "https://ci.example.test",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        VITE_CLERK_JWT_TEMPLATE: "template_legacy",
        STUDIO_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_canonical",
        VITE_STUDIO_RELAY_URL: "https://legacy.example.test",
        EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
        EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
        EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
      }),
    ).toEqual({
      clerkPublishableKey: "pk_legacy",
      clerkJwtTemplate: "template_legacy",
      clerkCliOAuthClientId: "oauth_canonical",
      relayUrl: "https://legacy.example.test",
      mobileOtlpTracesUrl: "https://api.axiom.co/v1/traces",
      mobileOtlpTracesDataset: "mobile-traces",
      mobileOtlpTracesToken: "mobile-token",
      relayClientOtlpTracesUrl: undefined,
      relayClientOtlpTracesDataset: undefined,
      relayClientOtlpTracesToken: undefined,
    });
  });

  it("projects canonical relay client tracing values to web build aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          STUDIO_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          STUDIO_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
          STUDIO_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      STUDIO_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      STUDIO_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
      STUDIO_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
      VITE_RELAY_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      VITE_RELAY_OTLP_TRACES_DATASET: "relay-client-traces",
      VITE_RELAY_OTLP_TRACES_TOKEN: "relay-client-token",
    });
  });

  it("projects canonical mobile tracing values to Expo public aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          STUDIO_RELAY_URL: "https://relay.example.test",
          STUDIO_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          STUDIO_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
          STUDIO_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      STUDIO_RELAY_URL: "https://relay.example.test",
      VITE_STUDIO_RELAY_URL: "https://relay.example.test",
      STUDIO_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      STUDIO_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
      STUDIO_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
      EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
    });
  });
});

describe("resolveBuildHostedServicesOptIn", () => {
  const complete = {
    STUDIO_ENABLE_HOSTED_SERVICES: "true",
    STUDIO_CLERK_PUBLISHABLE_KEY: "pk_live_example",
    STUDIO_CLERK_JWT_TEMPLATE: "studio-relay",
    STUDIO_CLERK_CLI_OAUTH_CLIENT_ID: "client_example",
    STUDIO_RELAY_URL: "https://relay.example.test",
  };

  it("opts in only when the gate and every public value are present", () => {
    expect(resolveBuildHostedServicesOptIn(complete)).toBe(true);
  });

  it("stays off without the gate, so unset release variables change nothing", () => {
    expect(
      resolveBuildHostedServicesOptIn({ ...complete, STUDIO_ENABLE_HOSTED_SERVICES: "" }),
    ).toBe(false);
    expect(resolveBuildHostedServicesOptIn({})).toBe(false);
  });

  it("stays off when any public value is missing or the relay is not HTTPS", () => {
    for (const key of [
      "STUDIO_CLERK_PUBLISHABLE_KEY",
      "STUDIO_CLERK_JWT_TEMPLATE",
      "STUDIO_CLERK_CLI_OAUTH_CLIENT_ID",
      "STUDIO_RELAY_URL",
    ] as const) {
      expect(resolveBuildHostedServicesOptIn({ ...complete, [key]: " " })).toBe(false);
    }
    expect(
      resolveBuildHostedServicesOptIn({
        ...complete,
        STUDIO_RELAY_URL: "http://relay.example.test",
      }),
    ).toBe(false);
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
