import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectSkillRepo,
  type ProjectSkillRow,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- real files in a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import { makeSkillSearch, type SkillSearchDeps } from "./SkillSearch.ts";

const projectId = ProjectId.make("skill-search");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const tempHome = Effect.promise(async () => {
  const dir = await NodeFSP.realpath(await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "skill-search-")));
  dirs.push(dir);
  return dir;
});
const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(join(file, ".."), { recursive: true });
    await NodeFSP.writeFile(file, text);
  });

const row = (name: string, description: string, version: string | null): ProjectSkillRow =>
  ({
    name,
    description,
    status: "ok",
    attention: false,
    issues: [],
    path: `/home/.agents/skills/${name}/SKILL.md`,
    scopes: ["user"],
    providers: [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        label: "Codex",
        path: `/home/.agents/skills/${name}/SKILL.md`,
        scope: "user",
        enabled: true,
        fileVersion: version,
      },
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        label: "Claude",
        path: `/home/.claude/skills/${name}/SKILL.md`,
        scope: "user",
        enabled: true,
        fileVersion: version,
      },
    ],
    lock: null,
    drift: "unlocked",
    copies: 1,
    divergent: false,
    doctor: [],
  }) as ProjectSkillRow;

const snapshot = (rows: ReadonlyArray<ProjectSkillRow>): ProjectSkillsSnapshot =>
  ({
    cwd: "/home",
    checkedAt: "2026-11-18T00:00:00.000Z",
    rows,
    providers: [],
    locks: [],
    doctor: "ok",
  }) as ProjectSkillsSnapshot;

const repoSkill = (name: string, version: string, description: string) => ({
  name,
  path: `skills/${name}/SKILL.md`,
  plugin: null,
  version,
  description,
  commit: "2".repeat(40),
  contentHash: "b".repeat(64),
});

const REPOS: ReadonlyArray<ProjectSkillRepo> = [
  {
    repo: "anton-abyzov/vskill",
    visibility: "public",
    connectedAt: "2026-11-18T00:00:00.000Z",
    state: "ok",
    commit: "2".repeat(40),
    checkedAt: "2026-11-18T00:00:00.000Z",
    skills: [
      repoSkill("html-report", "1.1.3", "Write reports"),
      repoSkill("report-builder", "0.4.0", "Build a weekly report"),
    ],
  },
  {
    repo: "acme/private-skills",
    visibility: "private",
    connectedAt: "2026-11-18T00:00:00.000Z",
    state: "needs-sign-in",
    commit: null,
    checkedAt: null,
    skills: [],
  },
];

interface Options {
  readonly rows?: ReadonlyArray<ProjectSkillRow>;
  readonly vaults?: Record<string, { readonly path: string; readonly open?: boolean; ts?: number }>;
  readonly limits?: SkillSearchDeps["limits"];
}

const fixture = (options: Options, files: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const home = yield* tempHome;
    const vault = join(home, "notes", "personal-docs");
    for (const [name, text] of Object.entries(files)) yield* write(join(vault, name), text);
    const vaults = options.vaults ?? { a: { path: vault, open: true, ts: 1 } };
    if (Object.keys(vaults).length > 0)
      yield* write(join(home, ".config", "obsidian", "obsidian.json"), JSON.stringify({ vaults }));
    const opened: string[] = [];
    const deps: SkillSearchDeps = {
      home,
      platform: "linux",
      environment: {},
      readSnapshot: () =>
        Effect.succeed(
          snapshot(options.rows ?? [row("html-report", "Write polished reports", "1.1.0")]),
        ),
      sources: { connected: () => Effect.succeed(REPOS) },
      openUrl: (url) =>
        Effect.sync(() => {
          opened.push(url);
          return true;
        }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    };
    const service = yield* makeSkillSearch(deps);
    return { home, vault, opened, service };
  });

const NOTES = {
  "003 Resources/AI Skills/Report skills.md": "# Report skills\nHow the html-report skill is used.",
  "Daily/2026-11-18.md": "Wrote the weekly REPORT for the team today.",
  "Daily/2026-11-17.md": "Nothing about that word here.",
  ".trash/Old report.md": "report report report",
  ".obsidian/workspace.md": "report",
  "Attachments/report.pdf": "report",
  "Attachments/report.txt": "report",
};

const live = NodeServices.layer;

describe("SkillSearch", () => {
  it.live("returns installed skills, skills in connected repos and notes as three groups", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({}, NOTES);
      const result = yield* fx.service.search({
        projectId,
        userLevel: true,
        operation: "search",
        query: " Report ",
      });
      expect(result.query).toBe("Report");
      expect(result.installed).toEqual([
        {
          name: "html-report",
          description: "Write polished reports",
          version: "1.1.0",
          agents: ["Codex", "Claude"],
        },
      ]);
      // html-report is installed, so only the other skill is offered, with the repo's version.
      expect(result.available).toEqual([
        {
          repo: "anton-abyzov/vskill",
          visibility: "public",
          skill: expect.objectContaining({ name: "report-builder", version: "0.4.0" }),
        },
      ]);
      expect(result.notes).toEqual([
        {
          title: "Report skills",
          path: "003 Resources/AI Skills/Report skills.md",
          vault: "personal-docs",
          snippet: expect.stringContaining("html-report"),
        },
        {
          title: "2026-11-18",
          path: "Daily/2026-11-18.md",
          vault: "personal-docs",
          snippet: expect.stringContaining("weekly REPORT"),
        },
      ]);
      expect(result.notesState).toBe("ok");
      // A search hands nothing to the OS and starts nothing.
      expect(fx.opened).toEqual([]);
    }).pipe(Effect.provide(live)),
  );

  it.live("reads markdown notes only and skips hidden folders", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({}, NOTES);
      const result = yield* fx.service.search({ projectId, operation: "search", query: "report" });
      const paths = result.notes.map((note) => note.path);
      expect(paths).not.toContain(".trash/Old report.md");
      expect(paths).not.toContain(".obsidian/workspace.md");
      expect(paths.every((path) => path.endsWith(".md"))).toBe(true);
      // The vault's own location never leaves the machine.
      expect(JSON.stringify(result)).not.toContain(fx.home);
    }).pipe(Effect.provide(live)),
  );

  it.live("stops at its limits and says the notes are partial", () =>
    Effect.gen(function* () {
      const files = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`n${index}.md`, `note ${index} about gardens`]),
      );
      const fx = yield* fixture({ limits: { maxContentFiles: 3, maxResults: 8 } }, files);
      const result = yield* fx.service.search({ projectId, operation: "search", query: "gardens" });
      expect(result.notes).toHaveLength(3);
      expect(result.notesState).toBe("partial");

      const capped = yield* fixture({ limits: { maxFiles: 5 } }, files);
      const partial = yield* capped.service.search({
        projectId,
        operation: "search",
        query: "gardens",
      });
      expect(partial.notes.length).toBeLessThanOrEqual(5);
      expect(partial.notesState).toBe("partial");
    }).pipe(Effect.provide(live)),
  );

  it.live("has no notes group to fill on a machine without a vault", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ vaults: {} });
      const result = yield* fx.service.search({ projectId, operation: "search", query: "report" });
      expect(result.notes).toEqual([]);
      expect(result.notesState).toBe("none");
      expect(result.installed).toHaveLength(1);
    }).pipe(Effect.provide(live)),
  );

  it.live("searches the vault Obsidian has open, one vault only", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({}, { "Open note.md": "zebra" });
      const other = join(fx.home, "notes", "other");
      yield* write(join(other, "Other note.md"), "zebra");
      yield* write(
        join(fx.home, ".config", "obsidian", "obsidian.json"),
        JSON.stringify({
          vaults: {
            a: { path: other, ts: 99 },
            b: { path: fx.vault, ts: 1, open: true },
            c: { path: join(fx.home, "gone"), ts: 100 },
          },
        }),
      );
      const service = yield* makeSkillSearch({
        home: fx.home,
        platform: "linux",
        environment: {},
        readSnapshot: () => Effect.succeed(snapshot([])),
        sources: { connected: () => Effect.succeed([]) },
        openUrl: () => Effect.succeed(true),
      });
      const result = yield* service.search({ projectId, operation: "search", query: "zebra" });
      expect(result.notes.map((note) => [note.vault, note.path])).toEqual([
        ["personal-docs", "Open note.md"],
      ]);
    }).pipe(Effect.provide(live)),
  );

  it.live("answers nothing for a query shorter than two characters", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({}, NOTES);
      const result = yield* fx.service.search({ projectId, operation: "search", query: " r " });
      expect(result).toMatchObject({ installed: [], available: [], notes: [], notesState: "ok" });
    }).pipe(Effect.provide(live)),
  );

  it.live("opens only a note the vault holds, by Obsidian's own link", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({}, NOTES);
      const opened = yield* fx.service.search({
        projectId,
        operation: "open-note",
        note: "003 Resources/AI Skills/Report skills.md",
      });
      expect(opened.opened).toBe(true);
      expect(fx.opened).toEqual([
        "obsidian://open?vault=personal-docs&file=003%20Resources%2FAI%20Skills%2FReport%20skills",
      ]);
      for (const note of ["../../etc/passwd", ".obsidian/workspace.md", "missing.md", ""]) {
        const refused = yield* fx.service.search({ projectId, operation: "open-note", note });
        expect(refused.opened).toBe(false);
      }
      expect(fx.opened).toHaveLength(1);
    }).pipe(Effect.provide(live)),
  );

  it.live("never reads a note whose link leaves the vault or points into a hidden folder", () =>
    Effect.gen(function* () {
      const fx = yield* fixture(
        {},
        { "Inside.md": "zebra inside", ".obsidian/app.md": "zebra app" },
      );
      const outside = join(fx.home, "outside.json");
      yield* write(outside, '{"token":"zebra outside secret"}');
      yield* Effect.promise(async () => {
        await NodeFSP.symlink(outside, join(fx.vault, "leak.md"));
        await NodeFSP.symlink(join(fx.vault, ".obsidian", "app.md"), join(fx.vault, "hidden.md"));
        await NodeFSP.symlink(join(fx.home), join(fx.vault, "up"));
      });
      const result = yield* fx.service.search({ projectId, operation: "search", query: "zebra" });
      const text = JSON.stringify(result);
      expect(text).not.toContain("outside secret");
      expect(text).not.toContain("zebra app");
      expect(result.notes.map((note) => note.path)).toContain("Inside.md");
      // A title match on the link's own name shows no text from its target.
      const byTitle = yield* fx.service.search({ projectId, operation: "search", query: "leak" });
      expect(byTitle.notes.every((note) => note.snippet === undefined)).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live("stops a walk of many folders and other files at its entry limit", () =>
    Effect.gen(function* () {
      const files = Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`assets/a${index}/image.png`, "x"]),
      );
      const fx = yield* fixture({ limits: { maxEntries: 10 } }, { ...files, "zz.md": "gardens" });
      const result = yield* fx.service.search({ projectId, operation: "search", query: "gardens" });
      expect(result.notesState).toBe("partial");
    }).pipe(Effect.provide(live)),
  );

  it.live("starts its deadline before the walk, so a slow walk answers partial", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ limits: { budgetMs: -1 } }, { "a/b/c.md": "gardens" });
      const result = yield* fx.service.search({ projectId, operation: "search", query: "gardens" });
      expect(result.notes).toEqual([]);
      expect(result.notesState).toBe("partial");
    }).pipe(Effect.provide(live)),
  );
});
