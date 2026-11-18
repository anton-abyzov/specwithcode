import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectSkillLock,
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
import type { CliRun } from "./ProjectSkillsActionsCommon.ts";
import type { SkillSourceRead } from "./SkillRepoSources.ts";
import {
  makeSkillUpdates,
  PRIVATE_SOURCE_MIN_VSKILL,
  skillReadiness,
  skillSourceLink,
  type SkillUpdatesDeps,
} from "./SkillUpdate.ts";

const projectId = ProjectId.make("skill-updates");
const OLD_SHA = "a".repeat(64);
const NEW_SHA = "b".repeat(64);
const OLD_COMMIT = "1".repeat(40);
const NEW_COMMIT = "2".repeat(40);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const tempHome = Effect.promise(async () => {
  const dir = await NodeFSP.realpath(await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "skill-update-")));
  dirs.push(dir);
  return dir;
});

interface LockEntry {
  readonly version: string;
  readonly sha?: string;
  readonly commit?: string;
  readonly source?: string;
  readonly pinnedVersion?: string;
  readonly path?: string;
  readonly branch?: string;
  readonly installedAt?: string;
}

const lockJson = (skills: Record<string, LockEntry>) =>
  `${JSON.stringify(
    {
      version: 1,
      agents: ["claude-code", "codex"],
      skills: Object.fromEntries(
        Object.entries(skills).map(([name, entry]) => [
          name,
          {
            version: entry.version,
            sha: entry.sha ?? OLD_SHA,
            tier: "VERIFIED",
            installedAt: entry.installedAt ?? "2026-11-01T00:00:00.000Z",
            source: entry.source ?? "github:anton-abyzov/vskill",
            scope: "user",
            sourceRepoUrl: "https://github.com/anton-abyzov/vskill",
            sourceSkillPath: entry.path ?? `skills/${name}/SKILL.md`,
            sourceBranch: entry.branch ?? "main",
            sourceCommitSha: entry.commit ?? OLD_COMMIT,
            ...(entry.pinnedVersion ? { pinnedVersion: entry.pinnedVersion } : {}),
          },
        ]),
      ),
    },
    null,
    2,
  )}\n`;

const presence = (instance: string, driver: string, label: string, name: string) => ({
  instanceId: ProviderInstanceId.make(instance),
  driver: ProviderDriverKind.make(driver),
  label,
  path: `/home/.agents/skills/${name}/SKILL.md`,
  scope: "user",
  enabled: true,
});

const AGENTS = [
  ["claudeAgent", "claudeAgent", "Claude"],
  ["codex", "codex", "Codex"],
  ["cursor", "cursor", "Cursor"],
] as const;

const rowFor = (
  name: string,
  lockPath: string,
  entry: LockEntry,
  agents: ReadonlyArray<string> = ["claudeAgent", "codex", "cursor"],
): ProjectSkillRow => {
  const source = entry.source ?? "github:anton-abyzov/vskill";
  const lock: ProjectSkillLock = {
    lockPath,
    lockScope: "user",
    version: entry.version,
    tier: "VERIFIED",
    source,
    sha: entry.sha ?? OLD_SHA,
    installedAt: entry.installedAt ?? "2026-11-01T00:00:00.000Z",
    name,
    pinnedVersion: entry.pinnedVersion ?? null,
    sourceRepoUrl: "https://github.com/anton-abyzov/vskill",
    sourceSkillPath: entry.path ?? `skills/${name}/SKILL.md`,
    sourceBranch: entry.branch ?? "main",
    sourceCommitSha: entry.commit ?? OLD_COMMIT,
    skillId: /^github:[^#]+$/.test(source) ? `${source.slice("github:".length)}/${name}` : null,
  };
  return {
    name,
    status: "ok",
    attention: false,
    issues: [],
    path: `/home/.agents/skills/${name}/SKILL.md`,
    scopes: ["user"],
    providers: AGENTS.filter(([instance]) => agents.includes(instance)).map(
      ([instance, driver, label]) => presence(instance, driver, label, name),
    ),
    lock,
    drift: "match",
    copies: 1,
    divergent: false,
    doctor: [],
  } as ProjectSkillRow;
};

const snapshotOf = (
  rows: ReadonlyArray<ProjectSkillRow>,
  states: Partial<Record<string, "ok" | "cached" | "timeout" | "error">> = {},
): ProjectSkillsSnapshot =>
  ({
    cwd: "/home",
    checkedAt: "2026-11-18T00:00:00.000Z",
    rows,
    providers: AGENTS.map(([instance, driver, label]) => ({
      instanceId: ProviderInstanceId.make(instance),
      driver: ProviderDriverKind.make(driver),
      label,
      state: states[instance] ?? "ok",
      skills: rows.length,
    })),
    locks: [],
    doctor: "ok",
  }) as ProjectSkillsSnapshot;

interface Call {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv | undefined;
}

interface Options {
  /** The lock as it is before anything runs. */
  readonly lock: Record<string, LockEntry>;
  /** What each source holds now: name -> latest, or a refusal. */
  readonly latest: Record<string, SkillSourceRead>;
  /** What a vskill install leaves in the lock; left out, the lock is untouched. */
  readonly afterInstall?: (name: string) => LockEntry | undefined;
  readonly installExit?: number;
  readonly vskillVersion?: string;
  readonly vskill?: string | null;
  readonly connected?: ReadonlyArray<ProjectSkillRepo>;
  /** Agents that list a skill only after it was installed. */
  readonly agentsAfter?: ReadonlyArray<string>;
  readonly states?: Partial<Record<string, "ok" | "cached" | "timeout" | "error">>;
}

const fixture = (options: Options) =>
  Effect.gen(function* () {
    const home = yield* tempHome;
    const lockPath = join(home, ".agents", "vskill.lock");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(join(home, ".agents"), { recursive: true });
      await NodeFSP.writeFile(lockPath, lockJson(options.lock));
    });
    const calls: Call[] = [];
    const reads: Array<{ refresh: boolean }> = [];
    const rescans: Array<ReadonlyArray<string>> = [];
    let lock = { ...options.lock };
    let installed = false;
    const run: SkillUpdatesDeps["run"] = ({ command, args, cwd, env }) =>
      Effect.promise(async (): Promise<CliRun> => {
        calls.push({ command, args, cwd, env });
        if (args[0] === "--version")
          return {
            exitCode: 0,
            stdout: `${options.vskillVersion ?? "1.2.14"}\n`,
            stderr: "",
            timedOut: false,
          };
        if (args[0] === "install") {
          if ((options.installExit ?? 0) !== 0)
            return {
              exitCode: options.installExit!,
              stdout: "",
              stderr: "scan said no",
              timedOut: false,
            };
          const name = args[1]!.split("/").at(-1)!;
          const next = options.afterInstall?.(name);
          if (next !== undefined) {
            lock = { ...lock, [name]: next };
            installed = true;
            await NodeFSP.writeFile(lockPath, lockJson(lock));
          }
        }
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      });
    const deps: SkillUpdatesDeps = {
      home,
      environment: { PATH: "/usr/bin" },
      readSnapshot: (input) =>
        Effect.sync(() => {
          reads.push({ refresh: input.refresh === true });
          return snapshotOf(
            Object.entries(lock).map(([name, entry]) =>
              rowFor(
                name,
                lockPath,
                entry,
                installed && options.agentsAfter ? options.agentsAfter : undefined,
              ),
            ),
            options.states,
          );
        }),
      resolveCwd: () => Effect.succeed(home),
      invalidate: () => Effect.void,
      sources: {
        readSkill: (input) =>
          Effect.succeed(options.latest[input.name] ?? { state: "not-found" as const }),
        connected: () => Effect.succeed(options.connected ?? []),
      },
      findVskill: Effect.succeed(options.vskill === undefined ? "/opt/bin/vskill" : options.vskill),
      run,
      rescanOpenFolders: (instanceIds) => Effect.sync(() => void rescans.push(instanceIds)),
    };
    const service = yield* makeSkillUpdates(deps);
    return { home, lockPath, calls, reads, rescans, service };
  });

const latest = (
  name: string,
  version: string,
  contentHash: string,
  visibility: "public" | "private" = "public",
  where: { readonly branch?: string; readonly path?: string } = {},
): SkillSourceRead => ({
  state: "ok",
  visibility,
  branch: where.branch ?? "main",
  skill: {
    name,
    path: where.path ?? `skills/${name}/SKILL.md`,
    plugin: null,
    version,
    commit: NEW_COMMIT,
    contentHash,
  },
});

const link = (repo: string, name: string, branch = "main", folder = `skills/${name}`) =>
  `https://github.com/${repo}/tree/${branch}/${folder}`;
const installCalls = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.args[0] === "install");
const live = NodeServices.layer;

describe("skillReadiness", () => {
  const rows = [rowFor("html-report", "/lock", { version: "1.0.0" })];
  it("reads each agent's readiness from that agent's own list", () => {
    expect(skillReadiness(snapshotOf(rows), "html-report")).toEqual([
      expect.objectContaining({ label: "Claude", readiness: "next-session" }),
      expect.objectContaining({ label: "Codex", readiness: "loaded-now" }),
      // Cursor holds it in its folders, but nothing says it rescans them per message.
      expect.objectContaining({ label: "Cursor", readiness: "next-session" }),
    ]);
  });
  it("never reports loaded now for an agent that did not answer or does not list it", () => {
    expect(
      skillReadiness(snapshotOf(rows, { codex: "timeout", cursor: "cached" }), "html-report").map(
        (entry) => entry.readiness,
      ),
    ).toEqual(["next-session", "next-session", "next-session"]);
    expect(
      skillReadiness(
        snapshotOf([rowFor("html-report", "/lock", { version: "1.0.0" }, ["claudeAgent"])]),
        "html-report",
      ).map((entry) => entry.readiness),
    ).toEqual(["next-session", "next-session", "next-session"]);
  });
});

describe("SkillUpdates status", () => {
  it.live("compares content, so the same version with other content counts as different", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: {
          current: { version: "1.0.0" },
          moved: { version: "1.0.0" },
          newer: { version: "1.0.0" },
          silent: { version: "1.0.0" },
          pinned: { version: "1.0.0", pinnedVersion: "1.0.0" },
          plugin: { version: "1.6.0", source: "github:anton-abyzov/vskill#plugin:marketing" },
          hosted: { version: "1.0.3", source: "hosted-private:tenant/slug" },
          secret: { version: "1.0.0", source: "github:acme/private-skills" },
        },
        latest: {
          // The repo gained commits, but this skill's file is the same.
          current: latest("current", "1.0.0", OLD_SHA),
          moved: latest("moved", "1.0.0", NEW_SHA),
          newer: latest("newer", "1.1.0", NEW_SHA),
          pinned: latest("pinned", "1.1.0", NEW_SHA),
          secret: { state: "needs-sign-in" },
        },
      });
      const result = yield* fx.service.update({ projectId, userLevel: true, operation: "status" });
      const byName = Object.fromEntries(result.statuses.map((status) => [status.skill, status]));
      expect(byName.current).toMatchObject({
        state: "current",
        repo: "anton-abyzov/vskill",
        installed: { version: "1.0.0", commit: OLD_COMMIT, contentHash: OLD_SHA },
        latest: { version: "1.0.0", commit: NEW_COMMIT, contentHash: OLD_SHA },
      });
      expect(byName.moved!.state).toBe("changed");
      expect(byName.newer!.state).toBe("update");
      expect(byName.pinned!.state).toBe("pinned");
      expect(byName.silent!.state).toBe("unknown");
      expect(byName.plugin!.state).toBe("unsupported");
      expect(byName.hosted!.state).toBe("unsupported");
      expect(byName.secret).toMatchObject({ state: "needs-sign-in", latest: null });
      expect(result.outcomes).toBeUndefined();
      // A status read starts no process at all.
      expect(fx.calls).toEqual([]);
    }).pipe(Effect.provide(live)),
  );
});

describe("SkillUpdates update", () => {
  it.live("runs vskill with a fixed argv and reads version and commit back from the lock", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { "html-report": { version: "1.0.0" } },
        latest: { "html-report": latest("html-report", "1.1.3", NEW_SHA) },
        afterInstall: () => ({
          version: "1.1.3",
          sha: NEW_SHA,
          commit: NEW_COMMIT,
          installedAt: "2026-11-18T09:00:00.000Z",
        }),
      });
      const result = yield* fx.service.update({
        projectId,
        userLevel: true,
        operation: "update",
        skills: ["html-report"],
      });
      expect(installCalls(fx.calls)).toEqual([
        expect.objectContaining({
          command: "/opt/bin/vskill",
          args: ["install", link("anton-abyzov/vskill", "html-report"), "-y", "--global"],
          cwd: fx.home,
        }),
      ]);
      expect(result.outcomes).toEqual([
        {
          skill: "html-report",
          outcome: "updated",
          before: { version: "1.0.0", commit: OLD_COMMIT, contentHash: OLD_SHA },
          after: { version: "1.1.3", commit: NEW_COMMIT, contentHash: NEW_SHA },
          readiness: [
            expect.objectContaining({ label: "Claude", readiness: "next-session" }),
            expect.objectContaining({ label: "Codex", readiness: "loaded-now" }),
            expect.objectContaining({ label: "Cursor", readiness: "next-session" }),
          ],
        },
      ]);
      expect(result.statuses[0]).toMatchObject({ skill: "html-report", state: "current" });
      // The agents were asked to scan again, here and in the folders threads have open.
      expect(fx.reads.at(-1)).toEqual({ refresh: true });
      expect(fx.rescans).toEqual([["claudeAgent", "codex", "cursor"]]);
    }).pipe(Effect.provide(live)),
  );

  it.live("fails a run that exits cleanly but leaves the lock as it was", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { "html-report": { version: "1.0.0" } },
        latest: { "html-report": latest("html-report", "1.1.3", NEW_SHA) },
      });
      const result = yield* fx.service.update({
        projectId,
        userLevel: true,
        operation: "update",
        skills: ["html-report"],
      });
      expect(result.outcomes).toEqual([
        expect.objectContaining({
          skill: "html-report",
          outcome: "failed",
          after: { version: "1.0.0", commit: OLD_COMMIT, contentHash: OLD_SHA },
          message: expect.stringContaining("The source may have moved"),
        }),
      ]);
    }).pipe(Effect.provide(live)),
  );

  it.live("reports a failed vskill run with the end of its output", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { "html-report": { version: "1.0.0" } },
        latest: { "html-report": latest("html-report", "1.1.3", NEW_SHA) },
        installExit: 3,
      });
      const result = yield* fx.service.update({
        projectId,
        userLevel: true,
        operation: "update",
        skills: ["html-report"],
      });
      expect(result.outcomes![0]).toMatchObject({
        outcome: "failed",
        message: expect.stringContaining("scan said no"),
      });
    }).pipe(Effect.provide(live)),
  );

  it.live("Update all updates every outdated skill and lists each result", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: {
          current: { version: "1.0.0" },
          moved: { version: "1.0.0" },
          newer: { version: "1.0.0" },
          pinned: { version: "1.0.0", pinnedVersion: "1.0.0" },
        },
        latest: {
          current: latest("current", "1.0.0", OLD_SHA),
          moved: latest("moved", "1.0.0", NEW_SHA),
          newer: latest("newer", "1.1.0", NEW_SHA),
          pinned: latest("pinned", "1.1.0", NEW_SHA),
        },
        afterInstall: (name) => ({
          version: name === "newer" ? "1.1.0" : "1.0.0",
          sha: NEW_SHA,
          commit: NEW_COMMIT,
        }),
      });
      const result = yield* fx.service.update({ projectId, userLevel: true, operation: "update" });
      expect(installCalls(fx.calls).map((call) => call.args[1])).toEqual([
        link("anton-abyzov/vskill", "moved"),
        link("anton-abyzov/vskill", "newer"),
      ]);
      expect(result.outcomes!.map((outcome) => [outcome.skill, outcome.outcome])).toEqual([
        ["moved", "updated"],
        ["newer", "updated"],
        ["pinned", "skipped"],
      ]);
      expect(result.outcomes![2]!.message).toContain("Pinned at 1.0.0");
    }).pipe(Effect.provide(live)),
  );

  it.live("keeps a private source away from the registry", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { secret: { version: "1.0.0", source: "github:acme/private-skills" } },
        latest: { secret: latest("secret", "1.1.0", NEW_SHA, "private") },
        afterInstall: () => ({
          version: "1.1.0",
          sha: NEW_SHA,
          commit: NEW_COMMIT,
          source: "github:acme/private-skills",
        }),
      });
      const result = yield* fx.service.update({
        projectId,
        userLevel: true,
        operation: "update",
        skills: ["secret"],
      });
      expect(result.outcomes![0]!.outcome).toBe("updated");
      // No registry command and no `@version` (which vskill resolves on the registry).
      for (const call of fx.calls) {
        expect(["--version", "install"]).toContain(call.args[0]);
        expect(call.args.join(" ")).not.toContain("@");
      }
      const install = installCalls(fx.calls)[0]!;
      expect(install.args).toEqual([
        "install",
        link("acme/private-skills", "secret"),
        "-y",
        "--global",
      ]);
      expect(install.env).toMatchObject({
        VSKILL_NO_TELEMETRY: "1",
        VSKILL_API_BASE: "http://127.0.0.1:9",
        VSKILL_API_URL: "http://127.0.0.1:9",
      });
    }).pipe(Effect.provide(live)),
  );

  it.live("refuses a private source on a vskill too old to keep it off the registry", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { secret: { version: "1.0.0", source: "github:acme/private-skills" } },
        latest: { secret: latest("secret", "1.1.0", NEW_SHA, "private") },
        vskillVersion: "1.2.0",
      });
      const result = yield* fx.service.update({
        projectId,
        userLevel: true,
        operation: "update",
        skills: ["secret"],
      });
      expect(result.outcomes![0]).toMatchObject({
        outcome: "failed",
        message: expect.stringContaining(PRIVATE_SOURCE_MIN_VSKILL),
      });
      expect(installCalls(fx.calls)).toEqual([]);
    }).pipe(Effect.provide(live)),
  );

  it.live("leaves a public source's vskill environment alone", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { "html-report": { version: "1.0.0" } },
        latest: { "html-report": latest("html-report", "1.1.3", NEW_SHA) },
        afterInstall: () => ({ version: "1.1.3", sha: NEW_SHA, commit: NEW_COMMIT }),
      });
      yield* fx.service.update({ projectId, userLevel: true, operation: "update" });
      const install = installCalls(fx.calls)[0]!;
      expect(install.env?.VSKILL_API_BASE).toBeUndefined();
      expect(install.env?.VSKILL_NO_TELEMETRY).toBeUndefined();
    }).pipe(Effect.provide(live)),
  );

  it.live("says so when vskill is not installed", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { "html-report": { version: "1.0.0" } },
        latest: { "html-report": latest("html-report", "1.1.3", NEW_SHA) },
        vskill: null,
      });
      const result = yield* fx.service.update({ projectId, userLevel: true, operation: "update" });
      expect(result.outcomes![0]).toMatchObject({
        outcome: "failed",
        message: expect.stringContaining("vskill is not installed"),
      });
      expect(fx.calls).toEqual([]);
    }).pipe(Effect.provide(live)),
  );
});

describe("SkillUpdates source identity", () => {
  it("builds the one-skill address vskill installs, or refuses a shape it cannot", () => {
    expect(
      skillSourceLink(
        "acme/skills",
        { branch: "release", path: "skills/sample/SKILL.md" },
        "sample",
      ),
    ).toBe("https://github.com/acme/skills/tree/release/skills/sample");
    for (const [branch, path] of [
      ["feature/x", "skills/sample/SKILL.md"],
      ["main", "SKILL.md"],
      ["main", "skills/other/SKILL.md"],
      ["main", "skills/../sample/SKILL.md"],
      ["-x", "skills/sample/SKILL.md"],
      ["main", "skills/sample/README.md"],
    ] as const)
      expect(skillSourceLink("acme/skills", { branch, path }, "sample"), `${branch} ${path}`).toBe(
        null,
      );
  });

  it.live("updates from the recorded branch and path, not the default branch", () =>
    Effect.gen(function* () {
      const path = "plugins/team/skills/sample/SKILL.md";
      const fx = yield* fixture({
        lock: { sample: { version: "1.0.0", branch: "release", path } },
        latest: {
          sample: latest("sample", "1.1.0", NEW_SHA, "public", { branch: "release", path }),
        },
        afterInstall: () => ({
          version: "1.1.0",
          sha: NEW_SHA,
          commit: NEW_COMMIT,
          branch: "release",
          path,
        }),
      });
      const result = yield* fx.service.update({ projectId, userLevel: true, operation: "update" });
      expect(installCalls(fx.calls)[0]!.args[1]).toBe(
        link("anton-abyzov/vskill", "sample", "release", "plugins/team/skills/sample"),
      );
      expect(result.outcomes![0]!.outcome).toBe("updated");
    }).pipe(Effect.provide(live)),
  );

  it.live("fails a run that only rewrote the lock's timestamp", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { sample: { version: "1.0.0" } },
        latest: { sample: latest("sample", "2.0.0", NEW_SHA) },
        afterInstall: () => ({ version: "1.0.0", installedAt: "2026-11-18T09:00:00.000Z" }),
      });
      const result = yield* fx.service.update({ projectId, userLevel: true, operation: "update" });
      expect(result.outcomes![0]).toMatchObject({
        outcome: "failed",
        after: { version: "1.0.0", commit: OLD_COMMIT, contentHash: OLD_SHA },
        message: expect.stringContaining("not 2.0.0"),
      });
      expect(fx.rescans).toEqual([]);
    }).pipe(Effect.provide(live)),
  );

  it.live("fails a run whose lock records another branch or path", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { sample: { version: "1.0.0", branch: "release" } },
        latest: { sample: latest("sample", "1.1.0", NEW_SHA, "public", { branch: "release" }) },
        afterInstall: () => ({
          version: "1.1.0",
          sha: NEW_SHA,
          commit: NEW_COMMIT,
          branch: "main",
        }),
      });
      const result = yield* fx.service.update({ projectId, userLevel: true, operation: "update" });
      expect(result.outcomes![0]).toMatchObject({
        outcome: "failed",
        message: expect.stringContaining("on main, not"),
      });
    }).pipe(Effect.provide(live)),
  );

  it.live("shows a source vskill cannot install by itself as not updated from here", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { sample: { version: "1.0.0", path: "SKILL.md" } },
        latest: { sample: latest("sample", "1.1.0", NEW_SHA, "public", { path: "SKILL.md" }) },
      });
      const status = yield* fx.service.update({ projectId, userLevel: true, operation: "status" });
      expect(status.statuses[0]).toMatchObject({
        state: "unsupported",
        detail: expect.stringContaining("Update it with vskill directly"),
      });
      const all = yield* fx.service.update({ projectId, userLevel: true, operation: "update" });
      expect(all.outcomes).toEqual([]);
      const named = yield* fx.service.update({
        projectId,
        userLevel: true,
        operation: "update",
        skills: ["sample"],
      });
      expect(named.outcomes![0]).toMatchObject({ outcome: "skipped" });
      expect(fx.calls).toEqual([]);
    }).pipe(Effect.provide(live)),
  );

  it.live("refuses a public install on a vskill too old to install one skill by address", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: { "html-report": { version: "1.0.0" } },
        latest: { "html-report": latest("html-report", "1.1.3", NEW_SHA) },
        vskillVersion: "1.0.21",
      });
      const result = yield* fx.service.update({ projectId, userLevel: true, operation: "update" });
      expect(result.outcomes![0]).toMatchObject({
        outcome: "failed",
        message: expect.stringContaining("installs every skill"),
      });
      expect(installCalls(fx.calls)).toEqual([]);
    }).pipe(Effect.provide(live)),
  );
});

describe("SkillUpdates install", () => {
  const repo = (visibility: "public" | "private" = "public"): ProjectSkillRepo => ({
    repo: "anton-abyzov/vskill",
    visibility,
    connectedAt: "2026-11-18T00:00:00.000Z",
    state: "ok",
    commit: NEW_COMMIT,
    checkedAt: "2026-11-18T00:00:00.000Z",
    skills: [
      {
        name: "obsidian-brain",
        path: "plugins/personal/skills/obsidian-brain/SKILL.md",
        plugin: "personal",
        version: "1.0.12",
        commit: NEW_COMMIT,
        contentHash: NEW_SHA,
      },
    ],
  });

  it.live("installs a skill from a connected repo and reports each agent's readiness", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({
        lock: {},
        latest: {
          "obsidian-brain": latest("obsidian-brain", "1.0.12", NEW_SHA, "public", {
            path: "plugins/personal/skills/obsidian-brain/SKILL.md",
          }),
        },
        connected: [repo()],
        afterInstall: () => ({
          version: "1.0.12",
          sha: NEW_SHA,
          commit: NEW_COMMIT,
          path: "plugins/personal/skills/obsidian-brain/SKILL.md",
        }),
        agentsAfter: ["claudeAgent", "codex"],
      });
      const result = yield* fx.service.update({
        projectId,
        userLevel: true,
        operation: "install",
        install: { repo: "anton-abyzov/vskill", skill: "obsidian-brain" },
      });
      expect(installCalls(fx.calls)[0]!.args).toEqual([
        "install",
        link(
          "anton-abyzov/vskill",
          "obsidian-brain",
          "main",
          "plugins/personal/skills/obsidian-brain",
        ),
        "-y",
        "--global",
      ]);
      expect(result.outcomes).toEqual([
        {
          skill: "obsidian-brain",
          outcome: "installed",
          before: null,
          after: { version: "1.0.12", commit: NEW_COMMIT, contentHash: NEW_SHA },
          readiness: [
            expect.objectContaining({ label: "Claude", readiness: "next-session" }),
            expect.objectContaining({ label: "Codex", readiness: "loaded-now" }),
            // Cursor does not list it, so nothing is assumed.
            expect.objectContaining({ label: "Cursor", readiness: "next-session" }),
          ],
        },
      ]);
      expect(fx.rescans).toHaveLength(1);
    }).pipe(Effect.provide(live)),
  );

  it.live("refuses a repo that is not connected on this machine, or a skill it does not hold", () =>
    Effect.gen(function* () {
      const fx = yield* fixture({ lock: {}, latest: {}, connected: [repo()] });
      const other = yield* fx.service
        .update({
          projectId,
          userLevel: true,
          operation: "install",
          install: { repo: "someone/else", skill: "obsidian-brain" },
        })
        .pipe(Effect.flip);
      expect(other.message).toContain("Connect someone/else");
      const missing = yield* fx.service
        .update({
          projectId,
          userLevel: true,
          operation: "install",
          install: { repo: "anton-abyzov/vskill", skill: "nope" },
        })
        .pipe(Effect.flip);
      expect(missing.message).toContain("has no skill named nope");
      expect(fx.calls).toEqual([]);
    }).pipe(Effect.provide(live)),
  );

  it.live("calls an install current when the lock already held that exact copy", () =>
    Effect.gen(function* () {
      const path = "plugins/personal/skills/obsidian-brain/SKILL.md";
      const same = { version: "1.0.12", sha: NEW_SHA, commit: NEW_COMMIT, path };
      const fx = yield* fixture({
        lock: { "obsidian-brain": same },
        latest: {
          "obsidian-brain": latest("obsidian-brain", "1.0.12", NEW_SHA, "public", { path }),
        },
        connected: [repo()],
        afterInstall: () => ({ ...same, installedAt: "2026-11-18T09:00:00.000Z" }),
      });
      const result = yield* fx.service.update({
        projectId,
        userLevel: true,
        operation: "install",
        install: { repo: "anton-abyzov/vskill", skill: "obsidian-brain" },
      });
      expect(result.outcomes![0]!.outcome).toBe("current");
      expect(fx.rescans).toEqual([]);
    }).pipe(Effect.provide(live)),
  );
});
