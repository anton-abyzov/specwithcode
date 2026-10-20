import { type ProjectId, ProjectCoordinatorReplica } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { sha256 } from "../nodeCrypto.ts";

/**
 * A member copy's read-only copy of its coordinator's notes, goal and
 * instructions, so a takeover starts with them. One owner-only file per
 * project in the state directory; the database is not touched.
 */
export class CoordinatorReplicas extends Context.Service<
  CoordinatorReplicas,
  {
    readonly read: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<ProjectCoordinatorReplica>, CoordinatorReplicaError>;
    readonly write: (
      projectId: ProjectId,
      replica: ProjectCoordinatorReplica,
    ) => Effect.Effect<void, CoordinatorReplicaError>;
  }
>()("specweave-studio/project/CoordinatorReplicas") {}

export class CoordinatorReplicaError extends Schema.TaggedError<CoordinatorReplicaError>()(
  "CoordinatorReplicaError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

const DIRECTORY = "coordinator-replicas";
const decodeReplica = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectCoordinatorReplica));
const encodeReplica = Schema.encodeEffect(Schema.fromJsonString(ProjectCoordinatorReplica));

export const layer = Layer.effect(
  CoordinatorReplicas,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const config = yield* ServerConfig.ServerConfig;
    const directory = path.join(config.stateDir, DIRECTORY);
    // Project ids are not file names; their hash is.
    const fileOf = (projectId: ProjectId) =>
      path.join(directory, `${sha256([projectId]).toString("hex").slice(0, 32)}.json`);
    const failed = (cause: unknown) => new CoordinatorReplicaError({ cause });
    return CoordinatorReplicas.of({
      read: (projectId) =>
        Effect.gen(function* () {
          const file = fileOf(projectId);
          if (!(yield* fileSystem.exists(file))) return Option.none();
          return Option.some(yield* decodeReplica(yield* fileSystem.readFileString(file)));
        }).pipe(Effect.mapError(failed)),
      write: (projectId, replica) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
          const file = fileOf(projectId);
          const temporary = `${file}.${(yield* crypto.randomUUIDv4).slice(0, 8)}.tmp`;
          const text = yield* encodeReplica(replica);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* fileSystem.open(temporary, { flag: "w", mode: 0o600 });
              yield* handle.writeAll(new TextEncoder().encode(text));
              yield* handle.sync;
            }),
          );
          yield* fileSystem.rename(temporary, file);
        }).pipe(Effect.mapError(failed)),
    });
  }),
);

/** For tests: replicas kept in memory. */
export const layerMemory = Layer.sync(CoordinatorReplicas, () => {
  const replicas = new Map<string, ProjectCoordinatorReplica>();
  return CoordinatorReplicas.of({
    read: (projectId) => Effect.sync(() => Option.fromNullishOr(replicas.get(projectId))),
    write: (projectId, replica) => Effect.sync(() => void replicas.set(projectId, replica)),
  });
});
