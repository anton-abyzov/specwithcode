import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, skillRepoRefusalMessage } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- real files in a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { sha256 } from "../nodeCrypto.ts";
import { join } from "../nodePath.ts";
import type { CliRun } from "./ProjectSkillsActionsCommon.ts";
import {
  discoverRepoSkillPaths,
  makeSkillRepoSources,
  readSkillDescription,
  type SkillRepoSourcesDeps,
} from "./SkillRepoSources.ts";

const projectId = ProjectId.make("skill-repos");
const COMMIT = "b2b7b7eb4a8de7b1afcaea8ce5ff5f668dbe4681";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const tempDir = Effect.promise(async () => {
  const dir = await NodeFSP.realpath(await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "skill-repos-")));
  dirs.push(dir);
  return dir;
});

const skillFile = (name: string, version: string, shape: "metadata" | "top" = "metadata") =>
  [
    "---",
    `name: ${name}`,
    `description: "Does ${name} things"`,
    ...(shape === "metadata" ? ["metadata:", `  version: "${version}"`] : [`version: ${version}`]),
    "---",
    `# ${name}`,
    "",
  ].join("\n");

const TREE = JSON.stringify({
  sha: "tree",
  truncated: false,
  tree: [
    { path: "README.md", type: "blob" },
    { path: "skills/html-report/SKILL.md", type: "blob", size: 100 },
    { path: "skills/html-report/template.html", type: "blob", size: 100 },
    { path: "plugins/personal/skills/obsidian-brain/SKILL.md", type: "blob", size: 100 },
    { path: "plugins/personal/skills/.trash/old/SKILL.md", type: "blob", size: 100 },
    { path: "docs/SKILL.md", type: "blob", size: 100 },
    { path: "skills/nested/deeper/SKILL.md", type: "blob", size: 100 },
  ],
});

const FILES: Record<string, string> = {
  "skills/html-report/SKILL.md": skillFile("html-report", "1.1.3"),
  "plugins/personal/skills/obsidian-brain/SKILL.md": skillFile("obsidian-brain", "1.0.12", "top"),
};

const missing: CliRun = { exitCode: null, stdout: "", stderr: "", timedOut: false };
const ok = (stdout: string): CliRun => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const failed = (stderr: string): CliRun => ({ exitCode: 1, stdout: "", stderr, timedOut: false });

interface Harness {
  readonly urls: string[];
  readonly ghCalls: Array<ReadonlyArray<string>>;
  readonly deps: SkillRepoSourcesDeps;
  readonly storePath: string;
}

/** A machine whose `gh` and anonymous GitHub reads answer from the given tables. */
const harness = (options: {
  readonly gh?: (args: ReadonlyArray<string>) => CliRun;
  readonly get?: (url: string) => { status: number; body: string };
}) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const urls: string[] = [];
    const ghCalls: Array<ReadonlyArray<string>> = [];
    const storePath = join(dir, "skills", "connected-repos.json");
    const deps: SkillRepoSourcesDeps = {
      storePath,
      gh: (args) =>
        Effect.sync(() => {
          ghCalls.push(args);
          return options.gh ? options.gh(args) : missing;
        }),
      get: (url) =>
        Effect.sync(() => {
          urls.push(url);
          return options.get ? options.get(url) : { status: 0, body: "" };
        }),
    };
    return { urls, ghCalls, deps, storePath } satisfies Harness;
  });

/** Anonymous GitHub for the public repo `anton-abyzov/vskill`. */
const publicGet = (url: string) => {
  const api = "https://api.github.com/repos/anton-abyzov/vskill";
  if (url === api)
    return {
      status: 200,
      body: JSON.stringify({
        full_name: "anton-abyzov/vskill",
        private: false,
        default_branch: "main",
      }),
    };
  if (url === `${api}/commits/main`) return { status: 200, body: COMMIT };
  if (url === `${api}/git/trees/${COMMIT}?recursive=1`) return { status: 200, body: TREE };
  const raw = `https://raw.githubusercontent.com/anton-abyzov/vskill/${COMMIT}/`;
  if (url.startsWith(raw) && FILES[url.slice(raw.length)] !== undefined)
    return { status: 200, body: FILES[url.slice(raw.length)]! };
  return { status: 404, body: "" };
};

/** A signed-in `gh` that can read the private repo `acme/private-skills`. */
const privateGh = (args: ReadonlyArray<string>): CliRun => {
  if (args[0] === "auth") return ok("github.com\n  Logged in to github.com account me\n");
  const endpoint = args.at(-1)!;
  const repo = "repos/acme/private-skills";
  if (endpoint === repo)
    return ok(
      JSON.stringify({ full_name: "acme/private-skills", private: true, default_branch: "trunk" }),
    );
  if (endpoint === `${repo}/commits/trunk`) return ok(COMMIT);
  if (endpoint === `${repo}/git/trees/${COMMIT}?recursive=1`)
    return ok(
      JSON.stringify({ tree: [{ path: "skills/secret-sauce/SKILL.md", type: "blob", size: 10 }] }),
    );
  if (endpoint === `${repo}/contents/skills/secret-sauce/SKILL.md?ref=${COMMIT}`)
    return ok(skillFile("secret-sauce", "2.0.0"));
  return failed("gh: Not Found (HTTP 404)");
};

const live = NodeServices.layer;

describe("discoverRepoSkillPaths", () => {
  it("reads both layouts and nothing else", () => {
    expect(
      discoverRepoSkillPaths(
        [
          "skills/a/SKILL.md",
          "plugins/p/skills/b/SKILL.md",
          "plugins/p/skills/.trash/c/SKILL.md",
          "skills/a/agents/x.md",
          "a/SKILL.md",
          "SKILL.md",
          "skills/-flag/SKILL.md",
          "plugins/p/skills/a/SKILL.md",
        ].map((path) => ({ path, type: "blob" })),
      ),
    ).toEqual([
      { name: "a", path: "skills/a/SKILL.md", plugin: null },
      { name: "b", path: "plugins/p/skills/b/SKILL.md", plugin: "p" },
    ]);
  });
});

describe("readSkillDescription", () => {
  it("reads a quoted, plain or folded description", () => {
    expect(readSkillDescription('---\nname: a\ndescription: "Quoted text"\n---\n')).toBe(
      "Quoted text",
    );
    expect(readSkillDescription("---\ndescription: Plain text\n---\n")).toBe("Plain text");
    expect(readSkillDescription("---\ndescription: >\n  Folded\n  text\nname: a\n---\n")).toBe(
      "Folded text",
    );
    expect(readSkillDescription("# no frontmatter")).toBeUndefined();
  });
});

describe("SkillRepoSources", () => {
  it.live("connects a public repo and lists its skills with version and source commit", () =>
    Effect.gen(function* () {
      const fx = yield* harness({ get: publicGet });
      const sources = yield* makeSkillRepoSources(fx.deps);
      const first = yield* sources.repos({ projectId, operation: "read" });
      expect(first).toEqual({
        repos: [],
        suggestions: ["anton-abyzov/vskill", "anton-abyzov/anton-personal-skills"],
      });

      const result = yield* sources.repos({
        projectId,
        operation: "connect",
        repo: "https://github.com/anton-abyzov/vskill.git",
      });
      expect(result.refusal).toBeUndefined();
      expect(result.suggestions).toEqual(["anton-abyzov/anton-personal-skills"]);
      expect(result.repos).toHaveLength(1);
      expect(result.repos[0]).toMatchObject({
        repo: "anton-abyzov/vskill",
        visibility: "public",
        state: "ok",
        commit: COMMIT,
      });
      expect(result.repos[0]!.skills).toEqual([
        {
          name: "html-report",
          path: "skills/html-report/SKILL.md",
          plugin: null,
          version: "1.1.3",
          description: "Does html-report things",
          commit: COMMIT,
          contentHash: sha256([FILES["skills/html-report/SKILL.md"]!], "hex"),
        },
        {
          name: "obsidian-brain",
          path: "plugins/personal/skills/obsidian-brain/SKILL.md",
          plugin: "personal",
          version: "1.0.12",
          description: "Does obsidian-brain things",
          commit: COMMIT,
          contentHash: sha256(
            [FILES["plugins/personal/skills/obsidian-brain/SKILL.md"]!],
            "hex",
          ),
        },
      ]);
      // Without a sign-in, every read is an anonymous GET to GitHub's own hosts.
      for (const url of fx.urls)
        expect(["api.github.com", "raw.githubusercontent.com"]).toContain(new URL(url).host);
    }).pipe(Effect.provide(live)),
  );

  it.live("refuses a private repo without a GitHub sign-in and saves nothing", () =>
    Effect.gen(function* () {
      const fx = yield* harness({ get: () => ({ status: 404, body: '{"message":"Not Found"}' }) });
      const sources = yield* makeSkillRepoSources(fx.deps);
      const result = yield* sources.repos({
        projectId,
        operation: "connect",
        repo: "acme/private-skills",
      });
      expect(result.repos).toEqual([]);
      expect(result.refusal).toEqual({ reason: "needs-sign-in", repo: "acme/private-skills" });
      expect(skillRepoRefusalMessage(result.refusal!.reason, result.refusal!.repo, "M5")).toBe(
        "Sign in to GitHub on M5 to read acme/private-skills",
      );
      expect(yield* Effect.promise(() => NodeFSP.readFile(fx.storePath, "utf8").catch(() => null)))
        .toBeNull();
      // The only thing asked was GitHub itself; nothing went to a skill registry.
      expect(fx.urls).toEqual(["https://api.github.com/repos/acme/private-skills"]);
      expect(fx.urls.some((url) => url.includes("verified-skill"))).toBe(false);
    }).pipe(Effect.provide(live)),
  );

  it.live("reads a private repo only through gh, with a fixed argv", () =>
    Effect.gen(function* () {
      const fx = yield* harness({ gh: privateGh });
      const sources = yield* makeSkillRepoSources(fx.deps);
      const result = yield* sources.repos({
        projectId,
        operation: "connect",
        repo: "acme/private-skills",
      });
      expect(result.refusal).toBeUndefined();
      expect(result.repos[0]).toMatchObject({
        repo: "acme/private-skills",
        visibility: "private",
        state: "ok",
        commit: COMMIT,
        skills: [{ name: "secret-sauce", version: "2.0.0", commit: COMMIT }],
      });
      // No anonymous request names the private repo, to GitHub or anywhere else.
      expect(fx.urls).toEqual([]);
      expect(fx.ghCalls[0]).toEqual(["auth", "status", "--hostname", "github.com"]);
      for (const call of fx.ghCalls.slice(1)) {
        expect(call.slice(0, 3)).toEqual(["api", "--hostname", "github.com"]);
        expect(call.at(-1)).toMatch(/^repos\/acme\/private-skills(\/|$)/);
      }
    }).pipe(Effect.provide(live)),
  );

  it.live("says not found when the signed-in account cannot see the repo", () =>
    Effect.gen(function* () {
      const fx = yield* harness({ gh: privateGh });
      const sources = yield* makeSkillRepoSources(fx.deps);
      const result = yield* sources.repos({ projectId, operation: "connect", repo: "acme/nope" });
      expect(result.refusal).toEqual({ reason: "not-found", repo: "acme/nope" });
      expect(fx.urls).toEqual([]);
    }).pipe(Effect.provide(live)),
  );

  it.live("refuses text that is not a GitHub repo without asking anyone", () =>
    Effect.gen(function* () {
      const fx = yield* harness({});
      const sources = yield* makeSkillRepoSources(fx.deps);
      for (const repo of ["--upload-file=x/y", "https://gitlab.com/a/b", "just-a-name", ""]) {
        const result = yield* sources.repos({ projectId, operation: "connect", repo });
        expect(result.refusal?.reason).toBe("invalid");
      }
      expect(fx.urls).toEqual([]);
      expect(fx.ghCalls).toEqual([]);
    }).pipe(Effect.provide(live)),
  );

  it.live("keeps connected repos per machine and disconnects one", () =>
    Effect.gen(function* () {
      const fx = yield* harness({ get: publicGet, gh: () => missing });
      const sources = yield* makeSkillRepoSources(fx.deps);
      yield* sources.repos({ projectId, operation: "connect", repo: "anton-abyzov/vskill" });
      // Connecting the same repo twice keeps one entry.
      yield* sources.repos({ projectId, operation: "connect", repo: "Anton-Abyzov/VSkill" });

      // Another service on the same machine reads the same saved list.
      const again = yield* makeSkillRepoSources(fx.deps);
      const read = yield* again.repos({ projectId, operation: "read" });
      expect(read.repos.map((repo) => repo.repo)).toEqual(["anton-abyzov/vskill"]);

      const after = yield* again.repos({
        projectId,
        operation: "disconnect",
        repo: "anton-abyzov/vskill",
      });
      expect(after.repos).toEqual([]);
      expect(after.suggestions).toContain("anton-abyzov/vskill");
      expect((yield* sources.repos({ projectId, operation: "read" })).repos).toEqual([]);
    }).pipe(Effect.provide(live)),
  );

  it.live("shows a connected private repo as needing sign-in once the sign-in is gone", () =>
    Effect.gen(function* () {
      let signedIn = true;
      const fx = yield* harness({
        gh: (args) => (signedIn ? privateGh(args) : failed("You are not logged into any hosts")),
        get: () => ({ status: 404, body: "" }),
      });
      const sources = yield* makeSkillRepoSources(fx.deps);
      yield* sources.repos({ projectId, operation: "connect", repo: "acme/private-skills" });
      signedIn = false;
      const read = yield* sources.repos({ projectId, operation: "read", refresh: true });
      expect(read.repos[0]).toMatchObject({
        repo: "acme/private-skills",
        visibility: "private",
        state: "needs-sign-in",
        skills: [],
      });
    }).pipe(Effect.provide(live)),
  );

  it.live("reads one skill file at its recorded path for a repo that is not connected", () =>
    Effect.gen(function* () {
      const fx = yield* harness({ get: publicGet });
      const sources = yield* makeSkillRepoSources(fx.deps);
      const latest = yield* sources.readSkill({
        repo: "anton-abyzov/vskill",
        name: "html-report",
        path: "skills/html-report/SKILL.md",
      });
      expect(latest).toEqual({
        state: "ok",
        visibility: "public",
        skill: expect.objectContaining({ name: "html-report", version: "1.1.3", commit: COMMIT }),
      });
      expect((yield* sources.repos({ projectId, operation: "read" })).repos).toEqual([]);
    }).pipe(Effect.provide(live)),
  );
});
