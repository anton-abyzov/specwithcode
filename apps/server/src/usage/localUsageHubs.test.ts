import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  detectLocalUsageHubs,
  isLocalHubSource,
  localHubSourceId,
  managementKeyFromFile,
  proxyPort,
  toLocalUsageHub,
} from "./localUsageHubs.ts";

const source = (url: string) =>
  ({ kind: "cliproxy", url, managementKey: "", enabled: true }) as const;

/** A hub that answers only on the given ports, and records every URL asked. */
function hubs(ports: ReadonlyArray<number>) {
  const asked: Array<string> = [];
  const http = HttpClient.make((request) => {
    asked.push(request.url);
    return ports.includes(Number(new URL(request.url).port))
      ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")))
      : Effect.never;
  });
  return { asked, layer: Layer.succeed(HttpClient.HttpClient, http) };
}

const install = Effect.fn(function* (config: string, key?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const root = path.join(home, ".local", "share", "specweave", "proxy");
  yield* fs.makeDirectory(path.join(root, "secrets"), { recursive: true });
  yield* fs.writeFileString(path.join(root, "config.yaml"), config);
  if (key !== undefined) {
    yield* fs.writeFileString(path.join(root, "secrets", "management-key.txt"), key);
  }
  return home;
});

describe("proxyPort", () => {
  it("reads the top-level port and ignores nested ones", () => {
    expect(proxyPort('host: ""\nport: 8320 # local\n')).toBe(8320);
    expect(proxyPort("tls:\n  port: 9000\n")).toBe(8317);
    expect(proxyPort("port: 99999\n")).toBe(8317);
  });
});

describe("isLocalHubSource", () => {
  it("matches only a loopback source on the same port", () => {
    expect(isLocalHubSource(source("http://localhost:8317"), 8317)).toBe(true);
    expect(isLocalHubSource(source("http://127.0.0.1:8317/"), 8317)).toBe(true);
    expect(isLocalHubSource(source("http://127.0.0.1:8318"), 8317)).toBe(false);
    expect(isLocalHubSource(source("https://hub.example.ts.net:8317"), 8317)).toBe(false);
    expect(isLocalHubSource(source("not a url"), 8317)).toBe(false);
  });
});

describe("managementKeyFromFile", () => {
  it("accepts one trimmed line and nothing else", () => {
    expect(managementKeyFromFile("  key-value\n")).toBe("key-value");
    expect(managementKeyFromFile("")).toBeNull();
    expect(managementKeyFromFile("two words")).toBeNull();
    expect(managementKeyFromFile("x".repeat(513))).toBeNull();
  });
});

describe("detectLocalUsageHubs", () => {
  it.effect("finds a running install and never returns its key", () =>
    Effect.gen(function* () {
      const home = yield* install("port: 8320\n", "the-management-key\n");
      const http = hubs([8320]);
      const found = yield* detectLocalUsageHubs({ home, sources: {} }).pipe(
        Effect.provide(http.layer),
      );
      expect(found).toHaveLength(1);
      expect(toLocalUsageHub(found[0]!)).toEqual({
        id: "specweave",
        url: "http://127.0.0.1:8320",
        configPath: expect.stringContaining("config.yaml"),
        running: true,
        keyAvailable: true,
        sourceId: null,
      });
      expect(JSON.stringify(found.map(toLocalUsageHub))).not.toContain("the-management-key");
      // Only loopback is ever asked.
      expect(http.asked.every((url) => new URL(url).hostname === "127.0.0.1")).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  // Live clock: an install that does not answer is given up on after the probe's timeout.
  it.live("reports a stopped install without a key file, and the source already using it", () =>
    Effect.gen(function* () {
      const home = yield* install("# defaults\n");
      const found = yield* detectLocalUsageHubs({
        home,
        sources: { mine: source("http://localhost:8317") },
      }).pipe(Effect.provide(hubs([]).layer));
      expect(found.map(toLocalUsageHub)).toEqual([
        expect.objectContaining({
          url: "http://127.0.0.1:8317",
          running: false,
          keyAvailable: false,
          sourceId: "mine",
        }),
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("finds nothing on a machine without an install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const found = yield* detectLocalUsageHubs({ home, sources: {} }).pipe(
        Effect.provide(hubs([]).layer),
      );
      // A Homebrew install on the test machine is outside the temporary home.
      expect(found.filter((hub) => hub.id !== "homebrew")).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("localHubSourceId", () => {
  it("names the entry the settings dialog would for the same URL", () => {
    expect(localHubSourceId(8317)).toBe("cliproxy-127.0.0.1-8317");
  });
});
