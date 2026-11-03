import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as CoordinatorRearmStore from "./CoordinatorRearmStore.ts";

const layer = CoordinatorRearmStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-rearm-" })),
  Layer.provideMerge(NodeServices.layer),
);

const member = (machine: string) => ({
  environmentId: EnvironmentId.make(machine),
  projectId: ProjectId.make(`easychamp-${machine}`),
  coordinatorThreadId: ThreadId.make(`project-coordinator:easychamp-${machine}`),
});

/** M3's consent for the owner's list M1, M3, M4, as the owner's app writes it. */
const entry: CoordinatorRearmStore.RearmEntry = {
  logicalProjectId: "logical:easychamp",
  projectId: "easychamp-m3",
  consent: {
    chainId: "77777777-7777-4777-8777-777777777777",
    members: [member("m1"), member("m3"), member("m4")],
    afterMinutes: 5,
    fromEpoch: 2,
  },
  consentUpdatedAt: "2026-11-03T10:00:00.000Z",
  run: null,
};

const filePath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "coordinator-rearm.json");
});

describe("CoordinatorRearmStore", () => {
  it.effect("keeps entries in an owner-only file, and removes them", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorRearmStore.CoordinatorRearmStore;
      const fileSystem = yield* FileSystem.FileSystem;
      const file = yield* filePath;
      expect(yield* store.list).toEqual([]);
      expect(yield* store.modify(entry.logicalProjectId, () => entry)).toEqual(entry);
      expect(yield* store.get(entry.logicalProjectId)).toEqual(entry);
      expect(Number((yield* fileSystem.stat(file)).mode) & 0o777).toBe(0o600);
      expect(JSON.parse(yield* fileSystem.readFileString(file))).toMatchObject({
        version: 1,
        projects: [{ logicalProjectId: entry.logicalProjectId }],
      });
      // Undefined keeps the file as it is; null removes the entry.
      expect(yield* store.modify(entry.logicalProjectId, () => undefined)).toEqual(entry);
      expect(yield* store.modify(entry.logicalProjectId, () => null)).toBeUndefined();
      expect(yield* store.list).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a file whose consent lists fewer than two machines", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorRearmStore.CoordinatorRearmStore;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        yield* filePath,
        JSON.stringify({
          version: 1,
          projects: [{ ...entry, consent: { ...entry.consent, members: [member("m3")] } }],
        }),
      );
      const error = yield* Effect.flip(store.list);
      expect(error.operation).toBe("read");
    }).pipe(Effect.provide(layer)),
  );
});
