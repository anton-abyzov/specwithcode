import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { SKILL_CATALOG_MARKER, SKILL_CATALOG_NOTE_PATH } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a scratch vault folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import { renderSkillCatalog, writeSkillCatalog } from "./SkillCatalogNote.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const vault = () =>
  Effect.promise(async () => {
    const dir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "skill-catalog-"));
    dirs.push(dir);
    return dir;
  });
const read = (file: string) => Effect.promise(() => NodeFSP.readFile(file, "utf8"));

const skills = [
  {
    name: "html-report",
    repo: "anton-abyzov/vskill",
    version: "1.1.3",
    commit: "b2b7b7eb4a8de7b1afcaea8ce5ff5f668dbe4681",
    agents: ["Claude", "Codex"],
    machines: ["m4", "M5"],
  },
  { name: "gws", repo: null, version: null, commit: null, agents: ["Claude"], machines: ["m4"] },
];

describe("the generated Skills catalog note", () => {
  it("lists each skill with its source, version, agents and machines, under the marker", () => {
    const note = renderSkillCatalog({ machine: "m4", generatedAt: "November 18, 2026", skills });
    expect(note).toContain(SKILL_CATALOG_MARKER);
    expect(note).toContain(
      "| html-report | anton-abyzov/vskill | 1.1.3 (b2b7b7e) | Claude, Codex | m4, M5 |",
    );
    expect(note).toContain("| gws | Not tracked | Unknown | Claude | m4 |");
    // A pipe in a value cannot break the table.
    const odd = renderSkillCatalog({
      machine: "m4",
      generatedAt: "November 18, 2026",
      skills: [{ ...skills[1]!, name: "a|b" }],
    });
    expect(odd).toContain("a\\|b");
  });

  it.effect("writes the note inside the vault and regenerates its own note", () =>
    Effect.gen(function* () {
      const root = yield* vault();
      const first = renderSkillCatalog({ machine: "m4", generatedAt: "one", skills });
      expect(yield* writeSkillCatalog({ vault: Effect.succeed(root) }, first)).toBe("written");
      const second = renderSkillCatalog({ machine: "m4", generatedAt: "two", skills });
      expect(yield* writeSkillCatalog({ vault: Effect.succeed(root) }, second)).toBe("written");
      expect(yield* read(join(root, SKILL_CATALOG_NOTE_PATH))).toBe(second);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never overwrites a note a person wrote at that path", () =>
    Effect.gen(function* () {
      const root = yield* vault();
      const file = join(root, SKILL_CATALOG_NOTE_PATH);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(join(file, ".."), { recursive: true });
        await NodeFSP.writeFile(file, "# My own notes\n");
      });
      const note = renderSkillCatalog({ machine: "m4", generatedAt: "one", skills });
      expect(yield* writeSkillCatalog({ vault: Effect.succeed(root) }, note)).toBe("kept");
      expect(yield* read(file)).toBe("# My own notes\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does nothing on a machine without a vault", () =>
    Effect.gen(function* () {
      const note = renderSkillCatalog({ machine: "M5", generatedAt: "one", skills });
      expect(yield* writeSkillCatalog({ vault: Effect.succeed(null) }, note)).toBe("no-vault");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
