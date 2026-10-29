import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  connectFreeTunnelLimitConfig,
  globalManagedTunnelCapConfig,
  legacyManagedEndpointCleanupModeConfig,
  legacyTunnelGraceMinutesConfig,
  managedEndpointCleanupModeConfig,
} from "./Config.ts";

it.effect.each([
  { name: "missing", env: {}, expected: "off" },
  { name: "empty", env: { RELAY_TUNNEL_CLEANUP_MODE: "" }, expected: "off" },
  { name: "whitespace", env: { RELAY_TUNNEL_CLEANUP_MODE: "  \t" }, expected: "off" },
  { name: "off", env: { RELAY_TUNNEL_CLEANUP_MODE: "off" }, expected: "off" },
  {
    name: "dry-run",
    env: { RELAY_TUNNEL_CLEANUP_MODE: "dry-run" },
    expected: "dry-run",
  },
  { name: "enabled", env: { RELAY_TUNNEL_CLEANUP_MODE: "enabled" }, expected: "enabled" },
] as const)("loads $name cleanup mode as $expected", ({ env, expected }) =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({ env });
    expect(yield* managedEndpointCleanupModeConfig.parse(provider)).toBe(expected);
  }),
);

it.effect("rejects an invalid cleanup mode", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({
      env: { RELAY_TUNNEL_CLEANUP_MODE: "delete-everything" },
    });
    const error = yield* Effect.flip(managedEndpointCleanupModeConfig.parse(provider));

    expect(error._tag).toBe("ConfigError");
    expect(error.message).toContain('Expected "off" | "dry-run" | "enabled"');
  }),
);

it.effect("reads the legacy cleanup mode independently of the main one", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({
      env: { RELAY_TUNNEL_CLEANUP_MODE: "enabled", RELAY_LEGACY_TUNNEL_CLEANUP_MODE: "dry-run" },
    });
    expect(yield* managedEndpointCleanupModeConfig.parse(provider)).toBe("enabled");
    expect(yield* legacyManagedEndpointCleanupModeConfig.parse(provider)).toBe("dry-run");
    expect(
      yield* legacyManagedEndpointCleanupModeConfig.parse(ConfigProvider.fromEnv({ env: {} })),
    ).toBe("off");
  }),
);

it.effect.each([
  { name: "missing", env: {}, expected: Option.none() },
  {
    name: "positive",
    env: { RELAY_LEGACY_TUNNEL_GRACE_MINUTES: "10" },
    expected: Option.some(10),
  },
] as const)("loads a $name legacy grace override", ({ env, expected }) =>
  Effect.gen(function* () {
    const minutes = yield* legacyTunnelGraceMinutesConfig.parse(ConfigProvider.fromEnv({ env }));
    expect(minutes).toEqual(expected);
  }),
);

it.effect.each(["0", "-10"])("rejects a grace override of %s minutes", (value) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      legacyTunnelGraceMinutesConfig.parse(
        ConfigProvider.fromEnv({ env: { RELAY_LEGACY_TUNNEL_GRACE_MINUTES: value } }),
      ),
    );
    expect(error._tag).toBe("ConfigError");
  }),
);

it.effect.each([
  { name: "missing", env: {}, free: 3, cap: undefined },
  {
    name: "blank",
    env: { RELAY_CONNECT_FREE_TUNNEL_LIMIT: " ", RELAY_GLOBAL_MANAGED_TUNNEL_CAP: "" },
    free: 3,
    cap: undefined,
  },
  {
    name: "set",
    env: { RELAY_CONNECT_FREE_TUNNEL_LIMIT: "5", RELAY_GLOBAL_MANAGED_TUNNEL_CAP: "180" },
    free: 5,
    cap: 180,
  },
] as const)("loads $name Connect limits", ({ env, free, cap }) =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({ env });
    expect(yield* connectFreeTunnelLimitConfig.parse(provider)).toBe(free);
    expect(yield* globalManagedTunnelCapConfig.parse(provider)).toBe(cap);
  }),
);

it.effect.each(["0", "-1", "2.5", "many"])("rejects a global tunnel cap of %s", (value) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      globalManagedTunnelCapConfig.parse(
        ConfigProvider.fromEnv({ env: { RELAY_GLOBAL_MANAGED_TUNNEL_CAP: value } }),
      ),
    );
    expect(error._tag).toBe("ConfigError");
  }),
);
