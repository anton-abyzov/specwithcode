import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a private test home with real skill folders and locks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import type { CliRun } from "./ProjectSkillsActionsCommon.ts";
import { vskillContentSha } from "./projectSkillsInventory.ts";
import type { SkillRepoRead } from "./SkillRepoSources.ts";
import { type SkillAdoptDeps, makeSkillAdopt } from "./SkillAdopt.ts";

const projectId = ProjectId.make("project-adopt");
const COMMIT = "e".repeat(40);
const SOURCE =
  "---\nname: remotion-best-practices\nmetadata:\n  version: 2.0.1\n---\nUse Remotion.\n";
// What an `npx skills --copy` install for another agent keeps: the Claude-only field removed.
const SOURCE_WITH_CLAUDE_FIELD =
  "---\nname: tax-filing\nuser-invocable: true\nmetadata:\n  version: 1.0.0\n---\nFile taxes.\n";
const STRIPPED_COPY = "---\nname: tax-filing\nmetadata:\n  version: 1.0.0\n---\nFile taxes.\n";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const home = () =>
  Effect.promise(async () => {
    const dir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "skill-adopt-"));
    dirs.push(dir);
    return dir;
  });
const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(join(file, ".."), { recursive: true });
    await NodeFSP.writeFile(file, text);
  });
const read = (file: string) => Effect.promise(() => NodeFSP.readFile(file, "utf8"));
const exists = (file: string) =>
  Effect.promise(() =>
    NodeFSP.stat(file).then(
      () => true,
      () => false,
    ),
  );

const repoRead = (
  repo: string,
  skills: ReadonlyArray<{ name: string; text: string; path?: string }>,
): SkillRepoRead => ({
  state: "ok",
  repo,
  visibility: "public",
  commit: COMMIT,
  branch: "main",
  checkedAt: "2026-11-18T12:00:00.000Z",
  truncated: false,
  skills: skills.map((skill) => ({
    name: skill.name,
    path: skill.path ?? `skills/${skill.name}/SKILL.md`,
    plugin: null,
    version: /version: (\S+)/.exec(skill.text)?.[1] ?? null,
    commit: COMMIT,
    contentHash: vskillContentSha(skill.text),
  })),
});

const npxLock = (entries: Record<string, unknown>) =>
  JSON.stringify({ version: 3, skills: entries, dismissed: {}, lastSelectedAgents: [] }, null, 2);

function deps(
  root: string,
  options: {
    repos?: Record<string, SkillRepoRead>;
    texts?: Record<string, string>;
    gh?: (args: ReadonlyArray<string>, stdin?: string) => CliRun;
    calls?: Array<{ args: ReadonlyArray<string>; stdin?: string }>;
    /** Make the vskill lock write lose the entry, as a crashed write would. */
    loseWrite?: boolean;
  } = {},
): SkillAdoptDeps {
  const repos = options.repos ?? {
    "remotion-dev/skills": repoRead("remotion-dev/skills", [
      { name: "remotion-best-practices", text: SOURCE },
    ]),
  };
  return {
    home: root,
    stateDir: join(root, ".state"),
    connectedIds: Effect.succeed(Object.keys(repos)),
    readRepo: (repo) => Effect.succeed(repos[repo] ?? { state: "not-found" }),
    readText: (_repo, path) =>
      Effect.succeed(
        options.texts?.[path] ??
          (path.includes("remotion")
            ? SOURCE
            : path.includes("tax")
              ? SOURCE_WITH_CLAUDE_FIELD
              : null),
      ),
    gh: (args, stdin) =>
      Effect.sync(() => {
        options.calls?.push({ args, ...(stdin === undefined ? {} : { stdin }) });
        return (
          options.gh?.(args, stdin) ?? { exitCode: 0, stdout: "{}", stderr: "", timedOut: false }
        );
      }),
    ...(options.loseWrite ? { afterLockWrite: (file: string) => write(file, "{}") } : {}),
  };
}

const adopt = (d: SkillAdoptDeps) => makeSkillAdopt(d).pipe(Effect.provide(NodeServices.layer));

describe("Adopt", () => {
  it.live("lists npx skills and untracked folders with their connected-repo match", () =>
    Effect.gen(function* () {
      const root = yield* home();
      yield* write(join(root, ".agents/skills/remotion-best-practices/SKILL.md"), SOURCE);
      yield* write(join(root, ".agents/skills/gws/SKILL.md"), "---\nname: gws\n---\nHand copy.\n");
      yield* write(
        join(root, ".agents/.skill-lock.json"),
        npxLock({ "remotion-best-practices": { source: "remotion-dev/skills" } }),
      );
      const service = yield* adopt(deps(root));
      const result = yield* service.adopt({ projectId, operation: "check" });
      const byName = new Map(result.candidates!.map((entry) => [entry.skill, entry]));
      expect(byName.get("remotion-best-practices")).toMatchObject({
        tracker: "npx-skills",
        trackedSource: "remotion-dev/skills",
        match: { repo: "remotion-dev/skills", contentHash: vskillContentSha(SOURCE) },
      });
      expect(byName.get("gws")).toMatchObject({ tracker: "none", match: null });
    }),
  );

  it.live("never replaces a vskill lock it cannot read, so no other skill is untracked", () =>
    Effect.gen(function* () {
      const root = yield* home();
      yield* write(join(root, ".agents/skills/remotion-best-practices/SKILL.md"), SOURCE);
      // The lock is a link to a file elsewhere: it is not followed and not overwritten.
      const elsewhere = join(root, "elsewhere.lock");
      yield* write(
        elsewhere,
        JSON.stringify({ version: 1, skills: { other: { version: "1.0.0" } } }),
      );
      yield* Effect.promise(() => NodeFSP.symlink(elsewhere, join(root, ".agents/vskill.lock")));
      const service = yield* adopt(deps(root));
      const result = yield* service.adopt({
        projectId,
        operation: "adopt",
        skill: "remotion-best-practices",
      });
      expect(result.outcome).toMatchObject({
        outcome: "failed",
        message: expect.stringMatching(/vskill.lock could not be read/),
      });
      expect(JSON.parse(yield* read(elsewhere)).skills).toHaveProperty("other");
      expect(
        (yield* Effect.promise(() =>
          NodeFSP.lstat(join(root, ".agents/vskill.lock")),
        )).isSymbolicLink(),
      ).toBe(true);
    }),
  );

  it.live("matches a copy whose Claude-only fields were stripped, like the fleet path", () =>
    Effect.gen(function* () {
      const root = yield* home();
      yield* write(join(root, ".agents/skills/tax-filing/SKILL.md"), STRIPPED_COPY);
      const service = yield* adopt(
        deps(root, {
          repos: {
            "someone/private-skills": repoRead("someone/private-skills", [
              { name: "tax-filing", text: SOURCE_WITH_CLAUDE_FIELD },
            ]),
          },
        }),
      );
      const result = yield* service.adopt({ projectId, operation: "check" });
      expect(result.candidates![0]!.match?.repo).toBe("someone/private-skills");
    }),
  );

  it.live(
    "records the vskill entry, reads it back, then releases the npx entry, keeping the folder",
    () =>
      Effect.gen(function* () {
        const root = yield* home();
        const folder = join(root, ".agents/skills/remotion-best-practices");
        yield* write(join(folder, "SKILL.md"), SOURCE);
        yield* write(join(folder, "rules/a.md"), "rule\n");
        yield* write(
          join(root, ".agents/.skill-lock.json"),
          npxLock({
            "remotion-best-practices": { source: "remotion-dev/skills" },
            other: { source: "someone/else" },
          }),
        );
        const service = yield* adopt(deps(root));
        const result = yield* service.adopt({
          projectId,
          operation: "adopt",
          skill: "remotion-best-practices",
        });
        expect(result.outcome).toMatchObject({
          outcome: "adopted",
          version: "2.0.1",
          commit: COMMIT.slice(0, 7),
          releasedFromNpxSkills: true,
        });
        const lock = JSON.parse(yield* read(join(root, ".agents/vskill.lock")));
        expect(lock.skills["remotion-best-practices"]).toMatchObject({
          version: "2.0.1",
          sha: vskillContentSha(SOURCE),
          source: "github:remotion-dev/skills",
          sourceSkillPath: "skills/remotion-best-practices/SKILL.md",
          sourceBranch: "main",
          sourceCommitSha: COMMIT,
          scope: "user",
        });
        const npx = JSON.parse(yield* read(join(root, ".agents/.skill-lock.json")));
        expect(Object.keys(npx.skills)).toEqual(["other"]);
        expect(npx.version).toBe(3);
        // The folder and its files are untouched.
        expect(yield* read(join(folder, "SKILL.md"))).toBe(SOURCE);
        expect(yield* exists(join(folder, "rules/a.md"))).toBe(true);
      }),
  );

  it.live("leaves the npx entry alone when the vskill entry does not read back", () =>
    Effect.gen(function* () {
      const root = yield* home();
      yield* write(join(root, ".agents/skills/remotion-best-practices/SKILL.md"), SOURCE);
      const npx = npxLock({ "remotion-best-practices": { source: "remotion-dev/skills" } });
      yield* write(join(root, ".agents/.skill-lock.json"), npx);
      const service = yield* adopt(deps(root, { loseWrite: true }));
      const result = yield* service.adopt({
        projectId,
        operation: "adopt",
        skill: "remotion-best-practices",
      });
      expect(result.outcome?.outcome).toBe("failed");
      expect(yield* read(join(root, ".agents/.skill-lock.json"))).toBe(npx);
      expect(yield* exists(join(root, ".agents/skills/remotion-best-practices/SKILL.md"))).toBe(
        true,
      );
    }),
  );

  it.live("refuses to adopt a folder that matches nothing", () =>
    Effect.gen(function* () {
      const root = yield* home();
      yield* write(join(root, ".agents/skills/gws/SKILL.md"), "---\nname: gws\n---\nHand copy.\n");
      const service = yield* adopt(deps(root));
      const result = yield* service.adopt({ projectId, operation: "adopt", skill: "gws" });
      expect(result.outcome).toMatchObject({
        outcome: "failed",
      });
      expect(yield* exists(join(root, ".agents/vskill.lock"))).toBe(false);
    }),
  );
});

describe("Add to a skill repo", () => {
  const ghAnswers = (args: ReadonlyArray<string>): CliRun => {
    const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
    const ok = (stdout: unknown) => ({
      exitCode: 0,
      stdout: JSON.stringify(stdout),
      stderr: "",
      timedOut: false,
    });
    if (/\/git\/ref\/heads\//.test(endpoint)) return ok({ object: { sha: "f".repeat(40) } });
    if (/\/pulls$/.test(endpoint))
      return ok({ html_url: "https://github.com/someone/private-skills/pull/7" });
    if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) return ok({ default_branch: "main" });
    return ok({});
  };

  it.live("lists the files for the confirmation and leaves out hidden files", () =>
    Effect.gen(function* () {
      const root = yield* home();
      yield* write(join(root, ".agents/skills/gws/SKILL.md"), "---\nname: gws\n---\nHand copy.\n");
      yield* write(join(root, ".agents/skills/gws/.env"), "SECRET=1\n");
      const service = yield* adopt(
        deps(root, { repos: { "someone/private-skills": repoRead("someone/private-skills", []) } }),
      );
      const result = yield* service.adopt({
        projectId,
        operation: "propose-preview",
        skill: "gws",
        repo: "someone/private-skills",
      });
      expect(result.proposal?.files).toEqual(["skills/gws/SKILL.md"]);
      expect(result.proposal?.skipped).toEqual([".env"]);
    }),
  );

  it.live("opens a pull request only for the confirmed files and never merges it", () =>
    Effect.gen(function* () {
      const root = yield* home();
      yield* write(join(root, ".agents/skills/gws/SKILL.md"), "---\nname: gws\n---\nHand copy.\n");
      const calls: Array<{ args: ReadonlyArray<string>; stdin?: string }> = [];
      const d = deps(root, {
        repos: { "someone/private-skills": repoRead("someone/private-skills", []) },
        gh: ghAnswers,
        calls,
      });
      const service = yield* adopt(d);
      const preview = yield* service.adopt({
        projectId,
        operation: "propose-preview",
        skill: "gws",
        repo: "someone/private-skills",
      });
      // A changed folder no longer matches what was confirmed.
      const stale = yield* service
        .adopt({
          projectId,
          operation: "propose",
          skill: "gws",
          repo: "someone/private-skills",
          fingerprint: "not-it",
          confirmed: true,
        })
        .pipe(Effect.flip);
      expect(stale.reason).toBe("scope_unsupported");
      expect(calls).toHaveLength(0);
      const opened = yield* service.adopt({
        projectId,
        operation: "propose",
        skill: "gws",
        repo: "someone/private-skills",
        fingerprint: preview.proposal!.fingerprint,
        confirmed: true,
      });
      expect(opened.pullRequestUrl).toBe("https://github.com/someone/private-skills/pull/7");
      expect(calls.every((call) => call.args[0] === "api")).toBe(true);
      expect(calls.some((call) => call.args.some((arg) => /\/merge$/.test(arg)))).toBe(false);
      expect(calls.some((call) => call.args.includes("repos/someone/private-skills/pulls"))).toBe(
        true,
      );
    }),
  );

  it.live("deletes its branch again when a file upload fails part way", () =>
    Effect.gen(function* () {
      const root = yield* home();
      yield* write(join(root, ".agents/skills/gws/SKILL.md"), "---\nname: gws\n---\nHand copy.\n");
      const calls: Array<{ args: ReadonlyArray<string>; stdin?: string }> = [];
      const failing = (args: ReadonlyArray<string>): CliRun =>
        args.includes("PUT")
          ? { exitCode: 1, stdout: "", stderr: "HTTP 422", timedOut: false }
          : ghAnswers(args);
      const service = yield* adopt(
        deps(root, {
          repos: { "someone/private-skills": repoRead("someone/private-skills", []) },
          gh: failing,
          calls,
        }),
      );
      const preview = yield* service.adopt({
        projectId,
        operation: "propose-preview",
        skill: "gws",
        repo: "someone/private-skills",
      });
      yield* service
        .adopt({
          projectId,
          operation: "propose",
          skill: "gws",
          repo: "someone/private-skills",
          fingerprint: preview.proposal!.fingerprint,
          confirmed: true,
        })
        .pipe(Effect.flip);
      const deleted = calls.find((call) => call.args.includes("DELETE"));
      expect(deleted?.args.at(-1)).toMatch(
        /^repos\/someone\/private-skills\/git\/refs\/heads\/add-skill-gws-/,
      );
      expect(calls.some((call) => call.args.includes("repos/someone/private-skills/pulls"))).toBe(
        false,
      );
    }),
  );

  it.live("refuses when the repo already holds a skill with that name", () =>
    Effect.gen(function* () {
      const root = yield* home();
      yield* write(join(root, ".agents/skills/gws/SKILL.md"), "---\nname: gws\n---\nHand copy.\n");
      const service = yield* adopt(
        deps(root, {
          repos: {
            "someone/private-skills": repoRead("someone/private-skills", [
              { name: "gws", text: "---\nname: gws\n---\nOther.\n" },
            ]),
          },
        }),
      );
      const error = yield* service
        .adopt({
          projectId,
          operation: "propose-preview",
          skill: "gws",
          repo: "someone/private-skills",
        })
        .pipe(Effect.flip);
      expect(error.detail).toMatch(/already holds/);
    }),
  );
});
