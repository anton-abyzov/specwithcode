/**
 * SkillCatalogNote — the generated `Skills catalog` note in the Obsidian vault
 * (increment 1399, AC-11).
 *
 * It lists each skill on this machine with its source repo, version, agents
 * and the machines known to have the same copy. It is regenerated after
 * installs, updates, adoptions and rollouts, and carries a marker saying it
 * is generated and the source repo is where edits go. Obsidian is an index,
 * never the source: a note at that path without the marker is left alone.
 *
 * @module project/SkillCatalogNote
 */
import { SKILL_CATALOG_MARKER, SKILL_CATALOG_NOTE_PATH } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const MAX_NOTE_BYTES = 2 * 1024 * 1024;

export interface CatalogSkill {
  readonly name: string;
  readonly repo: string | null;
  readonly version: string | null;
  readonly commit: string | null;
  readonly agents: ReadonlyArray<string>;
  readonly machines: ReadonlyArray<string>;
}

const cell = (value: string) =>
  value
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();

/** The note's text. `generatedAt` is a readable date; the rows are sorted by name. */
export function renderSkillCatalog(input: {
  readonly machine: string;
  readonly generatedAt: string;
  readonly skills: ReadonlyArray<CatalogSkill>;
}): string {
  const rows = input.skills
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((skill) => {
      const version =
        skill.version === null
          ? "Unknown"
          : skill.commit === null
            ? skill.version
            : `${skill.version} (${skill.commit.slice(0, 7)})`;
      return `| ${[
        skill.name,
        skill.repo ?? "Not tracked",
        version,
        skill.agents.join(", ") || "None",
        skill.machines.join(", ") || input.machine,
      ]
        .map(cell)
        .join(" | ")} |`;
    });
  return [
    "---",
    "generated: specwithcode",
    "---",
    "",
    `> ${SKILL_CATALOG_MARKER}`,
    "",
    "# Skills catalog",
    "",
    `Written on ${cell(input.machine)} on ${cell(input.generatedAt)}. Machines lists where the same copy was last confirmed.`,
    "",
    "| Skill | Source repo | Version | Agents | Machines |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Writes the note into the vault, atomically; a person's own note at that path is kept. */
export const writeSkillCatalog = (
  deps: { readonly vault: Effect.Effect<string | null> },
  note: string,
): Effect.Effect<
  "written" | "no-vault" | "kept" | "failed",
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* deps.vault;
    if (root === null) return "no-vault" as const;
    const file = path.join(root, ...SKILL_CATALOG_NOTE_PATH.split("/"));
    const existing = yield* fs.stat(file).pipe(Effect.option);
    if (Option.isSome(existing)) {
      if (existing.value.type !== "File" || existing.value.size > BigInt(MAX_NOTE_BYTES))
        return "kept" as const;
      const text = yield* fs.readFileString(file);
      if (!text.includes(SKILL_CATALOG_MARKER)) return "kept" as const;
      if (text === note) return "written" as const;
    }
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    // The folder must still be inside the vault after any links are followed.
    const realRoot = yield* fs.realPath(root);
    const realDir = yield* fs.realPath(path.dirname(file));
    if (realDir !== realRoot && !realDir.startsWith(`${realRoot}${path.sep}`))
      return "kept" as const;
    const temporary = `${file}.${yield* Clock.currentTimeMillis}.tmp`;
    yield* fs.writeFileString(temporary, note, { flag: "wx" }).pipe(
      Effect.andThen(fs.rename(temporary, file)),
      Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
    );
    return "written" as const;
  }).pipe(Effect.orElseSucceed(() => "failed" as const));
