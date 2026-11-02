import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { makeSshAgentSocketLookup } from "./sshAgentSocket.ts";

const makeLookup = (input: {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  sockets: Set<string>;
  launchctl: () => string | undefined;
}) => {
  let launchctlCalls = 0;
  const lookup = makeSshAgentSocketLookup({
    env: input.env,
    platform: input.platform ?? "darwin",
    socketExists: (socketPath) => Effect.sync(() => input.sockets.has(socketPath)),
    launchctlGetenv: Effect.sync(() => {
      launchctlCalls += 1;
      return input.launchctl();
    }),
    // Synchronous in tests so the background refresh settles immediately.
    runFork: (effect) => Effect.runSync(effect),
  });
  return { lookup, launchctlCalls: () => launchctlCalls };
};

it.effect("uses the process SSH_AUTH_SOCK when its socket exists", () =>
  Effect.gen(function* () {
    const { lookup, launchctlCalls } = makeLookup({
      env: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
      sockets: new Set(["/tmp/agent.sock"]),
      launchctl: () => "/tmp/launchd.sock",
    });
    expect(yield* lookup.current).toBe("/tmp/agent.sock");
    expect(launchctlCalls()).toBe(0);
  }),
);

it.effect("falls back to launchctl on macOS when the server has no agent socket", () =>
  Effect.gen(function* () {
    const { lookup, launchctlCalls } = makeLookup({
      env: {},
      sockets: new Set(["/private/tmp/com.apple.launchd.x/Listeners"]),
      launchctl: () => "/private/tmp/com.apple.launchd.x/Listeners",
    });
    expect(yield* lookup.current).toBe("/private/tmp/com.apple.launchd.x/Listeners");
    expect(yield* lookup.current).toBe("/private/tmp/com.apple.launchd.x/Listeners");
    // Cached: looked up once at startup.
    expect(launchctlCalls()).toBe(1);
  }),
);

it.effect("falls back to launchctl when the process socket is gone", () =>
  Effect.gen(function* () {
    const { lookup } = makeLookup({
      env: { SSH_AUTH_SOCK: "/tmp/stale.sock" },
      sockets: new Set(["/tmp/launchd.sock"]),
      launchctl: () => "/tmp/launchd.sock",
    });
    // The first open triggers the lookup without waiting on it.
    expect(yield* lookup.current).toBeUndefined();
    expect(yield* lookup.current).toBe("/tmp/launchd.sock");
  }),
);

it.effect("returns nothing when launchctl has no socket or the socket is missing", () =>
  Effect.gen(function* () {
    const empty = makeLookup({ env: {}, sockets: new Set(), launchctl: () => undefined });
    expect(yield* empty.lookup.current).toBeUndefined();
    expect(yield* empty.lookup.current).toBeUndefined();
    // An empty answer is remembered instead of rerunning launchctl per terminal.
    expect(empty.launchctlCalls()).toBe(1);
    const missing = makeLookup({ env: {}, sockets: new Set(), launchctl: () => "/tmp/gone.sock" });
    expect(yield* missing.lookup.current).toBeUndefined();
  }),
);

it.effect("re-reads launchctl after the cached socket disappears", () =>
  Effect.gen(function* () {
    const sockets = new Set(["/tmp/first.sock"]);
    let value = "/tmp/first.sock";
    const { lookup, launchctlCalls } = makeLookup({ env: {}, sockets, launchctl: () => value });
    expect(yield* lookup.current).toBe("/tmp/first.sock");
    sockets.clear();
    sockets.add("/tmp/second.sock");
    value = "/tmp/second.sock";
    expect(yield* lookup.current).toBeUndefined();
    expect(yield* lookup.current).toBe("/tmp/second.sock");
    expect(launchctlCalls()).toBe(2);
  }),
);

it.effect("never runs launchctl off macOS", () =>
  Effect.gen(function* () {
    const { lookup, launchctlCalls } = makeLookup({
      env: {},
      platform: "linux",
      sockets: new Set(["/tmp/launchd.sock"]),
      launchctl: () => "/tmp/launchd.sock",
    });
    expect(yield* lookup.current).toBeUndefined();
    expect(launchctlCalls()).toBe(0);
  }),
);

it.effect("a failing launchctl lookup does not fail terminal start", () =>
  Effect.gen(function* () {
    const lookup = makeSshAgentSocketLookup({
      env: {},
      platform: "darwin",
      socketExists: () => Effect.succeed(true),
      launchctlGetenv: Effect.die(new Error("launchctl missing")),
      runFork: (effect) => Effect.runSync(effect),
    });
    expect(yield* lookup.current).toBeUndefined();
  }),
);
