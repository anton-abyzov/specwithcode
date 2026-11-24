/**
 * The database copy a machine saves before its personal assistant first
 * links (1448 AC-13), and the memory digest the owner's approval is bound to.
 *
 * @module personalLinkSnapshot
 */
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { sha256 } from "../nodeCrypto.ts";
import { snapshotLiveDatabase } from "../persistence/liveDatabaseSnapshot.ts";

export interface PersonalLinkSnapshotter {
  /** Saves a copy for `operationId` and returns its path; the same operation reuses its copy. */
  readonly snapshot: (operationId: string) => Effect.Effect<string, Error>;
}

/**
 * Without the live layer every snapshot fails, so a join never proceeds
 * without its copy (fail closed).
 */
export class PersonalLinkSnapshot extends Context.Reference<PersonalLinkSnapshotter>(
  "specweave-studio/project/PersonalLinkSnapshot",
  {
    defaultValue: () => ({
      snapshot: () => Effect.fail(new Error("This machine cannot save a database copy right now.")),
    }),
  },
) {}

const safeName = (operationId: string) =>
  operationId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "operation";

/**
 * Copies the live database with SQLite's online backup into
 * `<state>/backups/personal-link/<operation>.sqlite`, beside the database and
 * outside every project folder. Never opens the live files through `node:fs`.
 */
export const layerLive = Layer.effect(
  PersonalLinkSnapshot,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const dir = NodePath.join(config.stateDir, "backups", "personal-link");
    const done = new Map<string, string>();
    return {
      snapshot: (operationId: string) =>
        Effect.tryPromise({
          try: async () => {
            const target = NodePath.join(dir, `${safeName(operationId)}.sqlite`);
            const known = done.get(target);
            if (known !== undefined) return known;
            try {
              const written = await snapshotLiveDatabase(config.dbPath, target);
              if (written.quickCheck !== "ok")
                throw new Error(`The copy failed its check (${written.quickCheck}).`);
            } catch (error) {
              // A retry of the same operation after a restart: its copy is already there.
              if (!(error instanceof Error) || !error.message.includes("already exists"))
                throw error;
            }
            done.set(target, target);
            return target;
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
    };
  }),
);

interface HashedFile {
  readonly name: string;
  readonly sha256: string;
}

/** One digest of a seat's whole memory: names and content hashes, in name order. */
export const personalMemoryDigest = (files: ReadonlyArray<HashedFile>) =>
  sha256(files.map((file) => `${file.name}\u0000${file.sha256}\n`).toSorted(), "hex");

/**
 * The digest the memory had before `renames`, read from memory where they
 * already happened: lets a retried join match the owner's approval.
 */
export const memoryDigestBeforeRenames = (
  files: ReadonlyArray<HashedFile>,
  renames: ReadonlyArray<{ readonly from: string; readonly to: string }>,
) => {
  const back = new Map(renames.map((rename) => [rename.to, rename.from]));
  return personalMemoryDigest(
    files.map((file) => ({ name: back.get(file.name) ?? file.name, sha256: file.sha256 })),
  );
};
