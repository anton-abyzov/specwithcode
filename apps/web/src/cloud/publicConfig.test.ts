import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it("requires both public cloud values", () => {
    vi.stubEnv("VITE_STUDIO_ENABLE_HOSTED_SERVICES", "true");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_STUDIO_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "studio-relay");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_STUDIO_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("stays off without the hosted services opt-in, even fully configured", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "studio-relay");
    vi.stubEnv("VITE_STUDIO_RELAY_URL", "https://relay.example.test");

    vi.stubEnv("VITE_STUDIO_ENABLE_HOSTED_SERVICES", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_STUDIO_ENABLE_HOSTED_SERVICES", "false");
    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_STUDIO_ENABLE_HOSTED_SERVICES", "true");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "studio-relay");
    vi.stubEnv("VITE_STUDIO_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("reports the missing Clerk JWT template as structured configuration", () => {
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");

    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "STUDIO_CLERK_JWT_TEMPLATE" }),
    );
  });
});
