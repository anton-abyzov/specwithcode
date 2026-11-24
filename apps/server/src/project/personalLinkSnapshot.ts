// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite checks a saved copy (never the live database).
/**
 * The database copy a machine saves before its personal assistant first
 * links (1448 AC-13), and the memory digest the owner's approval is bound to.
 *
 * @module personalLinkSnapshot
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

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

/**
 * One file name per operation id: a readable prefix plus a hash of the whole
 * id, so two ids that sanitize alike never share a copy.
 */
export const snapshotFileName = (operationId: string) =>
  `${operationId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "operation"}-${sha256(
    [operationId],
    "hex",
  ).slice(0, 16)}.sqlite`;

/**
 * Whether `target` is an earlier complete copy for the same operation: a
 * regular file that is a database passing `quick_check`. Opens only the saved
 * copy, read-only, never the live database.
 */
const existingCopyIsSound = (target: string): boolean => {
  const stat = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) return false;
  try {
    const copy = new NodeSqlite.DatabaseSync(target, { readOnly: true });
    try {
      return String(Object.values(copy.prepare("PRAGMA quick_check").get() ?? {})[0]) === "ok";
    } finally {
      copy.close();
    }
  } catch {
    return false;
  }
};

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
            const target = NodePath.join(dir, snapshotFileName(operationId));
            const known = done.get(target);
            if (known !== undefined) return known;
            if (NodeFS.existsSync(target)) {
              // A retry of the same operation after a restart: reuse its copy only when it is sound.
              if (!existingCopyIsSound(target))
                throw new Error(
                  `An unusable file is in the way of the database copy at ${target}.`,
                );
            } else {
              const written = await snapshotLiveDatabase(config.dbPath, target);
              if (written.quickCheck !== "ok")
                throw new Error(`The copy failed its check (${written.quickCheck}).`);
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
  const present = new Map(files.map((file) => [file.name, file.sha256]));
  return personalMemoryDigest(
    files
      // A rename that stopped halfway left the same content under both names: count it once.
      .filter((file) => {
        const from = back.get(file.name);
        return from === undefined || present.get(from) !== file.sha256;
      })
      .map((file) => ({ name: back.get(file.name) ?? file.name, sha256: file.sha256 })),
  );
};
