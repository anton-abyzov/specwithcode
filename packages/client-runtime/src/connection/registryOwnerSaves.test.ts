import { EnvironmentId } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BearerConnectionTarget,
  PersistedConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import { routesFingerprint } from "./registryOwnerSaves.ts";

// Synthetic machines only (1434).
describe("routesFingerprint", () => {
  const routes = [
    new BearerConnectionTarget({
      environmentId: EnvironmentId.make("environment-fixture"),
      label: "Fixture machine",
      connectionId: "bearer-fixture",
    }),
    new RelayConnectionTarget({
      environmentId: EnvironmentId.make("environment-fixture"),
      label: "Fixture machine",
    }),
    new SshConnectionTarget({
      environmentId: EnvironmentId.make("environment-fixture"),
      label: "Fixture machine",
      connectionId: "ssh-fixture",
    }),
  ];

  it("is the same after the routes are stored and read back", () => {
    const encode = Schema.encodeSync(Schema.Array(PersistedConnectionTarget));
    const decode = Schema.decodeUnknownSync(Schema.Array(PersistedConnectionTarget));
    const roundTripped = decode(JSON.parse(JSON.stringify(encode(routes))));
    expect(routesFingerprint(roundTripped)).toBe(routesFingerprint(routes));
  });

  it("ignores key order and changes with any route", () => {
    expect(routesFingerprint([{ b: 1, a: 2 }])).toBe(routesFingerprint([{ a: 2, b: 1 }]));
    expect(routesFingerprint(routes.slice(0, 2))).not.toBe(routesFingerprint(routes));
  });
});
