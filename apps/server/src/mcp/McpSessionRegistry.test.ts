import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(
      new Set(["preview", "orchestration", "worktree", "pull-requests"]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual([
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withDevice)).toEqual([
      "device",
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.thread.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

const layerSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-registry-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

/** A registry backed by `store`; two of them over one store model a server restart. */
const makeDurableRegistry = (
  store: ServerSecretStore.ServerSecretStore["Service"],
  now: () => number,
  livenessWindowMs = 100,
  retiredThreads?: McpSessionRegistry.McpRetiredThreads["Service"],
) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs,
      secretStore: store,
      ...(retiredThreads ? { retiredThreads } : {}),
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

const tokenOf = (issued: McpSessionRegistry.McpIssuedCredential) =>
  issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

it.effect("keeps honoring a credential after a server restart", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const threadId = ThreadId.make("thread-restart");
    const before = yield* makeDurableRegistry(store, () => 1_000);
    const issued = yield* before.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("grok"),
      capabilities: new Set(["preview"]),
    });
    const token = tokenOf(issued);
    // Tokens carry no "." so the endpoint never mistakes them for OAuth tokens.
    expect(token).not.toContain(".");

    // Only hashes are persisted, owner-only.
    const persisted = Option.getOrThrow(yield* store.get("mcp-credentials"));
    expect(new TextDecoder().decode(persisted)).not.toContain(token);
    const statePath = store.pathOf!("mcp-credentials");
    expect((yield* fileSystem.stat(statePath)).mode & 0o777).toBe(0o600);

    // The thread's credential file carries the current endpoint and token.
    const credentialFile = issued.config.credentialFile;
    expect(credentialFile).toBeDefined();
    expect((yield* fileSystem.stat(credentialFile!)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(yield* fileSystem.readFileString(credentialFile!))).toEqual({
      endpoint: issued.config.endpoint,
      authorization: issued.config.authorizationHeader,
    });

    const after = yield* makeDurableRegistry(store, () => 1_050);
    const resolved = yield* after.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.thread.providerSessionId).toBe(issued.config.providerSessionId);
    expect(resolved?.capabilities.has("preview")).toBe(true);

    // Re-issuing after the restart hands out the very token the agent holds.
    const reissued = yield* after.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("grok"),
      capabilities: new Set(["preview"]),
    });
    expect(tokenOf(reissued)).toBe(token);
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("forgets persisted credentials whose session stopped showing signs of life", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const before = yield* makeDurableRegistry(store, () => 1_000);
    const issued = yield* before.issue({
      threadId: ThreadId.make("thread-stale"),
      providerInstanceId: ProviderInstanceId.make("grok"),
    });
    const after = yield* makeDurableRegistry(store, () => 1_200);
    expect(yield* after.resolve(tokenOf(issued))).toBeUndefined();
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("re-issues the same token across revocation and capability changes", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const registry = yield* makeDurableRegistry(store, () => 1_000);
    const threadId = ThreadId.make("thread-stable");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const first = yield* registry.issue({
      threadId,
      providerInstanceId,
      capabilities: new Set(["preview"]),
    });
    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(tokenOf(first))).toBeUndefined();

    // A browser-access flip changes what the token may do, not the token.
    const second = yield* registry.issue({
      threadId,
      providerInstanceId,
      capabilities: new Set(["device"]),
    });
    expect(tokenOf(second)).toBe(tokenOf(first));
    const resolved = yield* registry.resolve(tokenOf(first));
    expect(resolved?.capabilities.has("preview")).toBe(false);
    expect(resolved?.capabilities.has("device")).toBe(true);

    // Other threads and provider instances never share a token.
    const otherInstance = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const otherThread = yield* registry.issue({
      threadId: ThreadId.make("thread-other"),
      providerInstanceId,
    });
    expect(tokenOf(otherInstance)).not.toBe(tokenOf(first));
    expect(tokenOf(otherThread)).not.toBe(tokenOf(first));
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("invalidating a thread retires its token permanently, also across restarts", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const registry = yield* makeDurableRegistry(store, () => 1_000);
    const threadId = ThreadId.make("thread-archived");
    const providerInstanceId = ProviderInstanceId.make("grok");
    const original = yield* registry.issue({ threadId, providerInstanceId });

    yield* registry.invalidateThread(threadId);
    expect(yield* registry.resolve(tokenOf(original))).toBeUndefined();
    expect(yield* fileSystem.exists(original.config.credentialFile!)).toBe(false);

    const replacement = yield* registry.issue({ threadId, providerInstanceId });
    expect(tokenOf(replacement)).not.toBe(tokenOf(original));

    const restarted = yield* makeDurableRegistry(store, () => 1_010);
    expect(yield* restarted.resolve(tokenOf(original))).toBeUndefined();
    expect(yield* restarted.resolve(tokenOf(replacement))).toBeDefined();
    const reissued = yield* restarted.issue({ threadId, providerInstanceId });
    expect(tokenOf(reissued)).toBe(tokenOf(replacement));
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("does not let a persisted record from another environment resolve", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const registry = yield* makeDurableRegistry(store, () => 1_000);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-foreign"),
      providerInstanceId: ProviderInstanceId.make("grok"),
    });
    const foreign = yield* McpSessionRegistry.__testing
      .make({ now: () => 1_010, livenessWindowMs: 100, secretStore: store })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-2")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
    expect(yield* foreign.resolve(tokenOf(issued))).toBeUndefined();
    // Issuing the same thread there still yields a different token.
    const reissued = yield* foreign.issue({
      threadId: ThreadId.make("thread-foreign"),
      providerInstanceId: ProviderInstanceId.make("grok"),
    });
    expect(tokenOf(reissued)).not.toBe(tokenOf(issued));
    expect(yield* foreign.resolve(tokenOf(issued))).toBeUndefined();
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("never revives an invalidated token after the store served another environment", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const request = {
      threadId: ThreadId.make("thread-roaming"),
      providerInstanceId: ProviderInstanceId.make("grok"),
    };
    const first = yield* makeDurableRegistry(store, () => 1_000);
    const original = yield* first.issue(request);
    yield* first.invalidateThread(request.threadId);

    const other = yield* McpSessionRegistry.__testing
      .make({ now: () => 1_005, livenessWindowMs: 100, secretStore: store })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-2")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
    yield* other.issue(request);

    const back = yield* makeDurableRegistry(store, () => 1_010);
    const reissued = yield* back.issue(request);
    expect(tokenOf(reissued)).not.toBe(tokenOf(original));
    expect(yield* back.resolve(tokenOf(original))).toBeUndefined();
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("replaces a truncated credential key instead of deriving tokens from it", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const request = {
      threadId: ThreadId.make("thread-key"),
      providerInstanceId: ProviderInstanceId.make("grok"),
    };
    const before = yield* makeDurableRegistry(store, () => 1_000);
    const original = yield* before.issue(request);
    // An interrupted write can leave the key empty next to a valid state.
    yield* store.set("mcp-credential-key", new Uint8Array());
    const registry = yield* makeDurableRegistry(store, () => 1_010);
    expect(yield* registry.resolve(tokenOf(original))).toBeUndefined();
    const issued = yield* registry.issue(request);
    const key = Option.getOrThrow(yield* store.get("mcp-credential-key"));
    expect(key.length).toBe(32);
    expect(tokenOf(issued)).not.toBe(tokenOf(original));
    expect(yield* registry.resolve(tokenOf(issued))).toBeDefined();
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("does not trust a credential state written under another key", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const request = {
      threadId: ThreadId.make("thread-mixed"),
      providerInstanceId: ProviderInstanceId.make("grok"),
    };
    const before = yield* makeDurableRegistry(store, () => 1_000);
    const original = yield* before.issue(request);
    // A key and a state from different moments, e.g. a partial backup restore.
    yield* store.set("mcp-credential-key", new Uint8Array(32).fill(7));
    const restarted = yield* makeDurableRegistry(store, () => 1_010);
    expect(yield* restarted.resolve(tokenOf(original))).toBeUndefined();
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect.each(["corrupt", "missing"] as const)(
  "never revives an invalidated token when the credential state is %s",
  (damage) =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const threadId = ThreadId.make("thread-damaged");
      const providerInstanceId = ProviderInstanceId.make("grok");
      const registry = yield* makeDurableRegistry(store, () => 1_000);
      const original = yield* registry.issue({ threadId, providerInstanceId });
      const kept = yield* registry.issue({
        threadId: ThreadId.make("thread-kept"),
        providerInstanceId,
      });
      yield* registry.invalidateThread(threadId);

      if (damage === "corrupt") {
        yield* store.set("mcp-credentials", new TextEncoder().encode("{not json"));
      } else {
        yield* store.remove("mcp-credentials");
      }
      const restarted = yield* makeDurableRegistry(store, () => 1_010);
      const reissued = yield* restarted.issue({ threadId, providerInstanceId });
      expect(tokenOf(reissued)).not.toBe(tokenOf(original));
      expect(yield* restarted.resolve(tokenOf(original))).toBeUndefined();
      // Failing closed costs the other threads their tokens too.
      expect(yield* restarted.resolve(tokenOf(kept))).toBeUndefined();
    }).pipe(Effect.provide(layerSecretStore())),
);

/** A store whose writes of the credential state and removal of the key can be failed. */
const makeFlakyStore = (store: ServerSecretStore.ServerSecretStore["Service"]) => {
  const faults = { stateWrites: false, keyRemoval: false, reads: false };
  const failure = (name: string) =>
    new ServerSecretStore.SecretStorePersistError({
      resource: `secret ${name}`,
      cause: new Error("disk unavailable"),
    });
  const flaky: ServerSecretStore.ServerSecretStore["Service"] = {
    ...store,
    get: (name) =>
      faults.reads
        ? Effect.fail(
            new ServerSecretStore.SecretStoreReadError({
              resource: `secret ${name}`,
              cause: new Error("disk unavailable"),
            }),
          )
        : store.get(name),
    set: (name, value) =>
      faults.stateWrites && name === "mcp-credentials"
        ? Effect.fail(failure(name))
        : store.set(name, value),
    remove: (name) =>
      faults.keyRemoval && name === "mcp-credential-key"
        ? Effect.fail(failure(name))
        : store.remove(name),
  };
  return { faults, flaky };
};

const revocations = [
  {
    name: "an invalidation",
    revoke: (registry: McpSessionRegistry.McpSessionRegistryShape, threadId: ThreadId) =>
      registry.invalidateThread(threadId),
  },
  {
    name: "a revocation",
    revoke: (registry: McpSessionRegistry.McpSessionRegistryShape, threadId: ThreadId) =>
      registry.revokeThread(threadId),
  },
  {
    name: "a capability reduction",
    revoke: (registry: McpSessionRegistry.McpSessionRegistryShape, threadId: ThreadId) =>
      registry
        .issue({
          threadId,
          providerInstanceId: ProviderInstanceId.make("grok"),
          capabilities: new Set(),
        })
        .pipe(Effect.asVoid),
  },
] as const;

it.effect.each(revocations)("retires the key when $name cannot be persisted", ({ revoke }) =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const { faults, flaky } = makeFlakyStore(store);
    const threadId = ThreadId.make("thread-unwritable");
    const providerInstanceId = ProviderInstanceId.make("grok");
    const registry = yield* makeDurableRegistry(flaky, () => 1_000);
    const original = yield* registry.issue({
      threadId,
      providerInstanceId,
      capabilities: new Set(["preview"]),
    });

    faults.stateWrites = true;
    yield* revoke(registry, threadId);

    const restarted = yield* makeDurableRegistry(store, () => 1_010);
    const resolved = yield* restarted.resolve(tokenOf(original));
    expect(resolved?.capabilities.has("preview") ?? false).toBe(false);
    expect(resolved).toBeUndefined();
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("never restores a retired key ahead of the state that retired it", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const { faults, flaky } = makeFlakyStore(store);
    const threadId = ThreadId.make("thread-retired");
    const providerInstanceId = ProviderInstanceId.make("grok");
    const registry = yield* makeDurableRegistry(flaky, () => 1_000);
    const original = yield* registry.issue({ threadId, providerInstanceId });

    faults.stateWrites = true;
    yield* registry.invalidateThread(threadId);
    // Another write while the state still cannot be stored.
    yield* registry.issue({ threadId: ThreadId.make("thread-other"), providerInstanceId });

    const restarted = yield* makeDurableRegistry(store, () => 1_010);
    expect(yield* restarted.resolve(tokenOf(original))).toBeUndefined();
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect.each(["revokeThread", "revokeProviderSession"] as const)(
  "stores %s even when this process never loaded the credential",
  (method) =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const { faults, flaky } = makeFlakyStore(store);
      const threadId = ThreadId.make("thread-unloaded");
      const first = yield* makeDurableRegistry(store, () => 1_000);
      const original = yield* first.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("grok"),
      });

      faults.reads = true;
      const blind = yield* makeDurableRegistry(flaky, () => 1_005);
      faults.reads = false;
      yield* method === "revokeThread"
        ? blind.revokeThread(threadId)
        : blind.revokeProviderSession(original.config.providerSessionId);

      const restarted = yield* makeDurableRegistry(store, () => 1_010);
      expect(yield* restarted.resolve(tokenOf(original))).toBeUndefined();
    }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("does not keep a credential alive past its stored liveness while writes fail", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const { faults, flaky } = makeFlakyStore(store);
    let now = 1_000;
    const registry = yield* makeDurableRegistry(flaky, () => now);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-unstored"),
      providerInstanceId: ProviderInstanceId.make("grok"),
    });

    faults.stateWrites = true;
    faults.keyRemoval = true;
    // Window 100ms, liveness written every 25ms: honored up to 125ms after
    // the last stored sign of life, however often it is used meanwhile.
    for (now = 1_010; now <= 1_120; now += 10) {
      expect(yield* registry.resolve(tokenOf(issued))).toBeDefined();
    }
    now = 1_130;
    expect(yield* registry.resolve(tokenOf(issued))).toBeUndefined();

    // Once writes work again, a live credential keeps renewing normally.
    faults.stateWrites = false;
    const renewed = yield* registry.issue({
      threadId: ThreadId.make("thread-unstored"),
      providerInstanceId: ProviderInstanceId.make("grok"),
    });
    for (now = 1_140; now <= 1_400; now += 10) {
      expect(yield* registry.resolve(tokenOf(renewed))).toBeDefined();
    }
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("keeps retrying a revocation that could not be stored at all", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const { faults, flaky } = makeFlakyStore(store);
    const threadId = ThreadId.make("thread-read-only");
    const providerInstanceId = ProviderInstanceId.make("grok");
    const registry = yield* makeDurableRegistry(flaky, () => 1_000);
    const original = yield* registry.issue({ threadId, providerInstanceId });

    faults.stateWrites = true;
    faults.keyRemoval = true;
    // Reported, so the outbox effect behind it retries; in force meanwhile.
    const failed = yield* Effect.flip(registry.invalidateThread(threadId));
    expect(failed._tag).toBe("McpCredentialRevocationError");
    expect(yield* registry.resolve(tokenOf(original))).toBeUndefined();
    // The store recovers; the next unrelated liveness update lands the revocation.
    faults.stateWrites = false;
    faults.keyRemoval = false;
    yield* registry.touch(ThreadId.make("thread-unrelated"));

    const restarted = yield* makeDurableRegistry(store, () => 1_010);
    expect(yield* restarted.resolve(tokenOf(original))).toBeUndefined();
    const reissued = yield* restarted.issue({ threadId, providerInstanceId });
    expect(tokenOf(reissued)).not.toBe(tokenOf(original));
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("stores revocations made after a start that could not read the store", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const { faults, flaky } = makeFlakyStore(store);
    const threadId = ThreadId.make("thread-unreadable");
    const providerInstanceId = ProviderInstanceId.make("grok");
    const first = yield* makeDurableRegistry(store, () => 1_000);
    const original = yield* first.issue({ threadId, providerInstanceId });

    faults.reads = true;
    const blind = yield* makeDurableRegistry(flaky, () => 1_005);
    faults.reads = false;
    yield* blind.invalidateThread(threadId);

    const restarted = yield* makeDurableRegistry(store, () => 1_010);
    expect(yield* restarted.resolve(tokenOf(original))).toBeUndefined();
    const reissued = yield* restarted.issue({ threadId, providerInstanceId });
    expect(tokenOf(reissued)).not.toBe(tokenOf(original));
  }).pipe(Effect.provide(layerSecretStore())),
);

// Live: the unserialized interleaving needs real file I/O time to show up.
it.live("never leaves a retired token in the credential file under concurrent issues", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let gateNextFileWrite = false;
    const slowStore: ServerSecretStore.ServerSecretStore["Service"] = {
      ...store,
      set: (name, value) =>
        gateNextFileWrite && name.startsWith("mcp-session-")
          ? Effect.sync(() => {
              gateNextFileWrite = false;
            }).pipe(
              Effect.andThen(Deferred.succeed(reached, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(store.set(name, value)),
            )
          : store.set(name, value),
    };
    const threadId = ThreadId.make("thread-race");
    const providerInstanceId = ProviderInstanceId.make("grok");
    const registry = yield* makeDurableRegistry(slowStore, () => 1_000);

    gateNextFileWrite = true;
    const stale = yield* Effect.forkChild(registry.issue({ threadId, providerInstanceId }));
    yield* Deferred.await(reached);
    const invalidation = yield* Effect.forkChild(registry.invalidateThread(threadId));
    const fresh = yield* Effect.forkChild(registry.issue({ threadId, providerInstanceId }));
    // Serialized, both wait for the stale issue; give them time to overtake it if not.
    yield* Fiber.await(fresh).pipe(Effect.timeoutOption("200 millis"));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(stale);
    yield* Fiber.join(invalidation);
    const issued = yield* Fiber.join(fresh);

    const file = JSON.parse(yield* fileSystem.readFileString(issued.config.credentialFile!)) as {
      readonly authorization: string;
    };
    expect(file.authorization).toBe(issued.config.authorizationHeader);
    expect(yield* registry.resolve(file.authorization.replace(/^Bearer\s+/, ""))).toBeDefined();
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("retires restored credentials of threads archived or deleted while it was down", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const providerInstanceId = ProviderInstanceId.make("grok");
    const archived = ThreadId.make("thread-archived-offline");
    const active = ThreadId.make("thread-still-active");
    const before = yield* makeDurableRegistry(store, () => 1_000);
    const archivedToken = tokenOf(yield* before.issue({ threadId: archived, providerInstanceId }));
    const activeToken = tokenOf(yield* before.issue({ threadId: active, providerInstanceId }));

    const asked: Array<ReadonlyArray<string>> = [];
    const retiredThreads = McpSessionRegistry.McpRetiredThreads.of({
      retiredAmong: (threadIds) =>
        Effect.sync(() => {
          asked.push([...threadIds].sort());
          return threadIds.filter((threadId) => threadId === archived);
        }),
    });
    const after = yield* makeDurableRegistry(store, () => 1_010, 100, retiredThreads);
    expect(asked).toEqual([[archived, active].sort()]);
    expect(yield* after.resolve(archivedToken)).toBeUndefined();
    expect((yield* after.resolve(activeToken))?.thread.threadId).toBe(active);

    // Retired for good: stored, and a later issue yields another token.
    const again = yield* makeDurableRegistry(store, () => 1_020);
    expect(yield* again.resolve(archivedToken)).toBeUndefined();
    const reissued = yield* again.issue({ threadId: archived, providerInstanceId });
    expect(tokenOf(reissued)).not.toBe(archivedToken);
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("retires every restored credential when retirement cannot be checked", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const threadId = ThreadId.make("thread-unchecked");
    const providerInstanceId = ProviderInstanceId.make("grok");
    const before = yield* makeDurableRegistry(store, () => 1_000);
    const token = tokenOf(yield* before.issue({ threadId, providerInstanceId }));

    const unavailable = McpSessionRegistry.McpRetiredThreads.of({
      retiredAmong: () => Effect.fail(new Error("database unavailable")),
    });
    const after = yield* makeDurableRegistry(store, () => 1_010, 100, unavailable);
    expect(yield* after.resolve(token)).toBeUndefined();

    // Even if the thread turns out active (or is unarchived), its old token
    // stays retired; its next session gets a new one.
    const later = yield* makeDurableRegistry(store, () => 1_020);
    const reissued = yield* later.issue({ threadId, providerInstanceId });
    expect(tokenOf(reissued)).not.toBe(token);
    expect(yield* later.resolve(token)).toBeUndefined();
    expect((yield* later.resolve(tokenOf(reissued)))?.thread.threadId).toBe(threadId);
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("retires an archived thread's expired credential too, so no re-issue revives it", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const threadId = ThreadId.make("thread-archived-expired");
    const providerInstanceId = ProviderInstanceId.make("grok");
    const before = yield* makeDurableRegistry(store, () => 1_000);
    const token = tokenOf(yield* before.issue({ threadId, providerInstanceId }));

    const retiredThreads = McpSessionRegistry.McpRetiredThreads.of({
      retiredAmong: (threadIds) => Effect.succeed(threadIds),
    });
    // Restarted after the liveness window: the record is no longer honored,
    // but the thread was archived and its token must stay retired.
    const after = yield* makeDurableRegistry(store, () => 1_500, 100, retiredThreads);
    const reissued = yield* after.issue({ threadId, providerInstanceId });
    expect(tokenOf(reissued)).not.toBe(token);
    expect(yield* after.resolve(token)).toBeUndefined();
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("stores a revocation once the store recovers, without other traffic", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const { faults, flaky } = makeFlakyStore(store);
    const threadId = ThreadId.make("thread-released");
    const registry = yield* makeDurableRegistry(flaky, () => 1_000);
    const original = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("grok"),
    });

    faults.stateWrites = true;
    faults.keyRemoval = true;
    yield* registry.revokeThread(threadId);
    faults.stateWrites = false;
    faults.keyRemoval = false;
    yield* TestClock.adjust("2 seconds");
    // The retry writes on its own; wait for the stored state to drop the record.
    yield* store.get("mcp-credentials").pipe(
      Effect.map((stored) =>
        Option.exists(stored, (bytes) => new TextDecoder().decode(bytes).includes(threadId)),
      ),
      Effect.tap(() => Effect.yieldNow),
      Effect.repeat({ while: (stale) => stale, times: 1_000 }),
    );

    const restarted = yield* makeDurableRegistry(store, () => 1_010);
    expect(yield* restarted.resolve(tokenOf(original))).toBeUndefined();
  }).pipe(Effect.provide(layerSecretStore())),
);

it.effect("stores all startup retirements in its first write, in case it crashes after", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const { faults, flaky } = makeFlakyStore(store);
    const providerInstanceId = ProviderInstanceId.make("grok");
    const threadIds = [ThreadId.make("thread-archived-a"), ThreadId.make("thread-archived-b")];
    const before = yield* makeDurableRegistry(store, () => 1_000);
    const tokens: Array<string> = [];
    for (const threadId of threadIds) {
      tokens.push(tokenOf(yield* before.issue({ threadId, providerInstanceId })));
    }

    // Only the first state write lands: the process "crashes" after it.
    faults.keyRemoval = true;
    const firstWriteOnly: ServerSecretStore.ServerSecretStore["Service"] = {
      ...flaky,
      set: (name, value) =>
        flaky.set(name, value).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (name === "mcp-credentials") faults.stateWrites = true;
            }),
          ),
        ),
    };
    const archived = McpSessionRegistry.McpRetiredThreads.of({
      retiredAmong: (ids) => Effect.succeed(ids),
    });
    yield* makeDurableRegistry(firstWriteOnly, () => 1_500, 100, archived);

    // Both threads unarchived later: neither may get its old token back.
    const later = yield* makeDurableRegistry(store, () => 1_600);
    for (const [index, threadId] of threadIds.entries()) {
      const reissued = yield* later.issue({ threadId, providerInstanceId });
      expect(tokenOf(reissued)).not.toBe(tokens[index]);
    }
  }).pipe(Effect.provide(layerSecretStore())),
);
