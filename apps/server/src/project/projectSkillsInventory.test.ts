import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  summarizeProjectSkills,
  type ServerProvider,
  type ServerProviderSkill,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  buildProjectSkillRows,
  parseVskillDoctorReport,
  parseVskillLock,
  vskillContentSha,
  type ProviderSkillSource,
  type SkillFileFact,
  type VskillLockEntry,
  type VskillLockSource,
} from "./projectSkillsInventory.ts";
import { gatherProjectSkills, readSkillFileFacts, runVskillDoctor } from "./projectSkillsScan.ts";
import { providerSkillsForCwd } from "./ProjectSkillsService.ts";

const CWD = "/work/app";
const HOME = "/home/me";

function provider(
  id: string,
  driver: string,
  label: string,
  skills: ReadonlyArray<ServerProviderSkill>,
): ProviderSkillSource {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    label,
    skills,
  };
}

function skill(name: string, path: string, extra: Partial<ServerProviderSkill> = {}) {
  return { name, path, enabled: true, scope: "project", ...extra } satisfies ServerProviderSkill;
}

function lockEntry(extra: Partial<VskillLockEntry> = {}): VskillLockEntry {
  return {
    version: "1.0.0",
    sha: null,
    tier: "VERIFIED",
    source: "github:owner/repo",
    installedAt: "2026-01-01T00:00:00.000Z",
    installedPath: null,
    files: ["SKILL.md"],
    pluginDir: false,
    ...extra,
  };
}

function lock(
  scope: "project" | "user",
  entries: Record<string, VskillLockEntry>,
): VskillLockSource {
  const root = scope === "project" ? CWD : `${HOME}/.agents`;
  return { path: `${root}/vskill.lock`, root, scope, entries: new Map(Object.entries(entries)) };
}

const fact = (realPath: string, content: string | null): SkillFileFact => ({
  realPath,
  digest: content === null ? null : vskillContentSha(content),
});

describe("vskillContentSha", () => {
  it("matches vskill's computeSha for normalized content", () => {
    // sha256("hello\n"), the digest vskill stores for this file.
    const expected = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
    assert.strictEqual(vskillContentSha("hello\n"), expected);
    assert.strictEqual(vskillContentSha("﻿hello\r\n"), expected);
  });
});

describe("parseVskillLock", () => {
  it("reads entries and skips malformed ones", () => {
    const entries = parseVskillLock(
      JSON.stringify({
        skills: {
          anymodel: { version: "1.0.1", sha: "abc", tier: "VERIFIED", files: ["SKILL.md"] },
          broken: "nope",
          plugin: { version: "2.0.0", sha: "", pluginDir: true },
        },
      }),
    );
    assert.deepEqual([...(entries?.keys() ?? [])], ["anymodel", "plugin"]);
    assert.strictEqual(entries?.get("anymodel")?.sha, "abc");
    assert.strictEqual(entries?.get("plugin")?.sha, null);
    assert.strictEqual(entries?.get("plugin")?.pluginDir, true);
    assert.strictEqual(parseVskillLock("{"), undefined);
  });
});

describe("parseVskillDoctorReport", () => {
  it("groups findings by skill name from several report shapes", () => {
    const report = parseVskillDoctorReport(
      JSON.stringify({
        problems: [
          { kind: "divergent", name: "deploy", message: "Two copies differ." },
          { type: "broken-link", path: "/p/.claude/skills/lint" },
          {
            code: "redundant-link",
            paths: ["/p/.agents/skills/lint/SKILL.md"],
            detail: "Redundant.",
          },
        ],
      }),
    );
    assert.deepEqual(Object.fromEntries(report ?? []), {
      deploy: ["Two copies differ."],
      lint: ["broken-link", "Redundant."],
    });
    assert.deepEqual(Object.fromEntries(parseVskillDoctorReport("[]") ?? []), {});
    assert.strictEqual(parseVskillDoctorReport("error: unknown command 'doctor'"), undefined);
    assert.strictEqual(parseVskillDoctorReport('{"ok":true}'), undefined);
  });
});

describe("buildProjectSkillRows", () => {
  it("joins providers by name, with lock info and a matching digest", () => {
    const content = "---\nname: deploy\n---\nBody\n";
    const projectPath = `${CWD}/.claude/skills/deploy/SKILL.md`;
    const sharedPath = `${CWD}/.agents/skills/deploy/SKILL.md`;
    const rows = buildProjectSkillRows({
      cwd: CWD,
      providers: [
        provider("claude", "claudeAgent", "Claude", [
          skill("deploy", projectPath, { description: "Ship it." }),
        ]),
        provider("codex", "codex", "Codex", [skill("deploy", sharedPath, { scope: "repo" })]),
      ],
      locks: [lock("project", { deploy: lockEntry({ sha: vskillContentSha(content) }) })],
      files: new Map([
        [projectPath, fact(sharedPath, content)],
        [sharedPath, fact(sharedPath, content)],
      ]),
      doctor: new Map(),
    });
    assert.strictEqual(rows.length, 1);
    const row = rows[0]!;
    assert.strictEqual(row.status, "ok");
    assert.strictEqual(row.attention, false);
    assert.strictEqual(row.drift, "match");
    assert.strictEqual(row.copies, 1);
    assert.strictEqual(row.description, "Ship it.");
    assert.deepEqual(row.scopes, ["project", "repo"]);
    assert.deepEqual(
      row.providers.map((presence) => presence.label),
      ["Claude", "Codex"],
    );
    assert.strictEqual(row.lock?.version, "1.0.0");
    assert.strictEqual(row.lock?.lockScope, "project");
    assert.deepEqual(row.issues, []);
  });

  it("flags drift when the file no longer hashes to the locked sha, accepting short prefixes", () => {
    const original = "original\n";
    const edited = "edited\n";
    const path = `${CWD}/.claude/skills/lint/SKILL.md`;
    const build = (content: string, sha: string) =>
      buildProjectSkillRows({
        cwd: CWD,
        providers: [provider("claude", "claudeAgent", "Claude", [skill("lint", path)])],
        locks: [lock("project", { lint: lockEntry({ sha }) })],
        files: new Map([[path, fact(path, content)]]),
        doctor: new Map(),
      })[0]!;
    const shortSha = vskillContentSha(original).slice(0, 12);
    assert.strictEqual(build(original, shortSha).drift, "match");
    const drifted = build(edited, shortSha);
    assert.strictEqual(drifted.drift, "drift");
    assert.strictEqual(drifted.status, "drift");
    assert.match(drifted.issues[0] ?? "", /changed since vskill installed it/);
  });

  it("reports unknown drift for empty shas and multi-file or plugin entries", () => {
    const path = `${CWD}/.claude/skills/kit/SKILL.md`;
    const build = (entry: VskillLockEntry) =>
      buildProjectSkillRows({
        cwd: CWD,
        providers: [provider("claude", "claudeAgent", "Claude", [skill("kit", path)])],
        locks: [lock("project", { kit: entry })],
        files: new Map([[path, fact(path, "x")]]),
        doctor: new Map(),
      })[0]!.drift;
    assert.strictEqual(build(lockEntry({ sha: null })), "unknown");
    assert.strictEqual(
      build(lockEntry({ sha: "a".repeat(64), files: ["SKILL.md", "refs/a.md"] })),
      "unknown",
    );
    assert.strictEqual(build(lockEntry({ sha: "a".repeat(64), pluginDir: true })), "unknown");
  });

  it("marks divergent copies as duplicate and identical copies as ok", () => {
    const user = `${HOME}/.claude/skills/review/SKILL.md`;
    const shared = `${HOME}/.agents/skills/review/SKILL.md`;
    const build = (userContent: string) =>
      buildProjectSkillRows({
        cwd: CWD,
        providers: [
          provider("claude", "claudeAgent", "Claude", [skill("review", user, { scope: "user" })]),
          provider("codex", "codex", "Codex", [skill("review", shared, { scope: "user" })]),
        ],
        locks: [],
        files: new Map([
          [user, fact(user, userContent)],
          [shared, fact(shared, "same\n")],
        ]),
        doctor: new Map(),
      })[0]!;
    const divergent = build("other\n");
    assert.strictEqual(divergent.status, "duplicate");
    assert.strictEqual(divergent.divergent, true);
    assert.strictEqual(divergent.copies, 2);
    assert.strictEqual(divergent.drift, "unlocked");
    const identical = build("same\n");
    assert.strictEqual(identical.status, "ok");
    assert.strictEqual(identical.divergent, false);
    assert.match(identical.issues[0] ?? "", /2 identical copies/);
  });

  it("adds rows for locked skills nobody loads, keyed by folder name", () => {
    const path = `${CWD}/.claude/skills/sw-do/SKILL.md`;
    const rows = buildProjectSkillRows({
      cwd: CWD,
      providers: [provider("claude", "claudeAgent", "Claude", [skill("sw:do", path)])],
      locks: [
        lock("project", {
          "sw-do": lockEntry(),
          ghost: lockEntry(),
          // A plugin install: its skills load namespaced, never under this key.
          frontend: lockEntry({ pluginDir: true, sha: "" }),
        }),
        lock("user", { ghost: lockEntry({ version: "9.0.0" }) }),
      ],
      files: new Map([[path, fact(path, "x")]]),
      doctor: new Map(),
    });
    assert.deepEqual(
      rows.map((row) => [row.name, row.status, row.lock?.version ?? null]),
      [
        ["ghost", "missing", "1.0.0"],
        ["sw:do", "ok", "1.0.0"],
      ],
    );
    assert.strictEqual(rows[0]!.copies, 0);
    assert.strictEqual(rows[0]!.path, null);
  });

  it("prefers the user lock for a skill that only loads from the user scope", () => {
    const path = `${HOME}/.agents/skills/gws/SKILL.md`;
    const row = buildProjectSkillRows({
      cwd: CWD,
      providers: [provider("codex", "codex", "Codex", [skill("gws", path, { scope: "user" })])],
      locks: [
        lock("project", { gws: lockEntry({ version: "1.0.0" }) }),
        lock("user", { gws: lockEntry({ version: "2.0.0" }) }),
      ],
      files: new Map([[path, fact(path, "x")]]),
      doctor: new Map(),
    })[0]!;
    assert.strictEqual(row.lock?.version, "2.0.0");
    assert.strictEqual(row.lock?.lockScope, "user");
  });

  it("reports disabled skills and doctor findings", () => {
    const path = `${CWD}/.claude/skills/old/SKILL.md`;
    const shared = `${CWD}/.agents/skills/old/SKILL.md`;
    const rows = buildProjectSkillRows({
      cwd: CWD,
      providers: [
        provider("claude", "claudeAgent", "Claude", [skill("old", path, { enabled: false })]),
        provider("codex", "codex", "Codex", [
          skill("old", shared, { enabled: false }),
          skill("fine", `${CWD}/.agents/skills/fine/SKILL.md`),
        ]),
      ],
      locks: [],
      files: new Map(),
      doctor: new Map([["fine", ["Description is too long."]]]),
    });
    const [fine, old] = rows;
    assert.strictEqual(old?.status, "disabled");
    assert.strictEqual(old?.attention, true);
    assert.strictEqual(fine?.status, "ok");
    assert.strictEqual(fine?.attention, true);
    assert.deepEqual(fine?.doctor, ["Description is too long."]);
    assert.strictEqual(summarizeProjectSkills(rows), "2 skills, 2 need attention");
    assert.strictEqual(summarizeProjectSkills([]), "0 skills, all ok");
  });
});

describe("providerSkillsForCwd", () => {
  const base = {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    status: "ready",
    skills: [skill("machine", "/m/SKILL.md")],
  } as unknown as ServerProvider;

  it("uses the folder snapshot and falls back to the machine list", () => {
    const withWorkspace = {
      ...base,
      workspaceSnapshots: [
        {
          cwd: CWD,
          checkedAt: "2026-01-01T00:00:00.000Z",
          slashCommands: [],
          skills: [skill("local", "/l/SKILL.md")],
        },
      ],
    } as ServerProvider;
    const scanned = providerSkillsForCwd(withWorkspace, CWD, "done");
    assert.deepEqual(
      scanned.source.skills.map((entry) => entry.name),
      ["local"],
    );
    assert.strictEqual(scanned.state.state, "ok");
    assert.strictEqual(scanned.state.label, "Claude");
    assert.strictEqual(providerSkillsForCwd(withWorkspace, CWD, "timeout").state.state, "cached");
    const machine = providerSkillsForCwd(base, CWD, "done");
    assert.strictEqual(machine.state.state, "unsupported");
    assert.deepEqual(
      machine.source.skills.map((entry) => entry.name),
      ["machine"],
    );
    const timedOut = providerSkillsForCwd(base, CWD, "timeout");
    assert.strictEqual(timedOut.state.state, "timeout");
    assert.strictEqual(timedOut.state.skills, 0);
  });
});

it.layer(NodeServices.layer)("gatherProjectSkills", (it) => {
  it.effect("reads project and user locks, resolves links and digests files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "studio-project-skills-" });
      const home = path.join(temp, "home");
      const project = path.join(temp, "project");
      const store = path.join(home, ".agents", "skills", "review");
      const content = "---\nname: review\n---\nReview.\n";
      yield* fs.makeDirectory(store, { recursive: true });
      yield* fs.writeFileString(path.join(store, "SKILL.md"), content);
      yield* fs.makeDirectory(path.join(home, ".claude", "skills"), { recursive: true });
      yield* fs.symlink(store, path.join(home, ".claude", "skills", "review"));
      const local = path.join(project, ".claude", "skills", "deploy");
      yield* fs.makeDirectory(local, { recursive: true });
      yield* fs.writeFileString(path.join(local, "SKILL.md"), "edited locally\n");
      yield* fs.writeFileString(
        path.join(project, "vskill.lock"),
        JSON.stringify({
          skills: { deploy: { version: "1.2.0", sha: vskillContentSha("as installed\n") } },
        }),
      );
      yield* fs.writeFileString(
        path.join(home, ".agents", "vskill.lock"),
        JSON.stringify({
          skills: { review: { version: "3.0.0", sha: vskillContentSha(content) } },
        }),
      );
      const linked = path.join(home, ".claude", "skills", "review", "SKILL.md");
      const shared = path.join(store, "SKILL.md");

      const facts = yield* readSkillFileFacts([linked, linked, shared]);
      assert.strictEqual(facts.size, 2);
      assert.strictEqual(facts.get(linked)?.realPath, yield* fs.realPath(shared));

      const snapshot = yield* gatherProjectSkills({
        cwd: project,
        homeDir: home,
        doctor: false,
        providers: [
          provider("claude", "claudeAgent", "Claude", [
            skill("deploy", path.join(local, "SKILL.md")),
            skill("review", linked, { scope: "user" }),
          ]),
          provider("codex", "codex", "Codex", [skill("review", shared, { scope: "user" })]),
        ],
        providerStates: [],
      });
      assert.strictEqual(snapshot.doctor, "unavailable");
      assert.deepEqual(
        snapshot.locks.map((entry) => [entry.scope, entry.skills]),
        [
          ["project", 1],
          ["user", 1],
        ],
      );
      assert.deepEqual(
        snapshot.rows.map((row) => [
          row.name,
          row.status,
          row.drift,
          row.copies,
          row.lock?.version,
        ]),
        [
          ["deploy", "drift", "drift", 1, "1.2.0"],
          ["review", "ok", "match", 1, "3.0.0"],
        ],
      );
    }),
  );
});

it.layer(NodeServices.layer)("runVskillDoctor", (it) => {
  const withFakeVskill = (script: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bin = yield* fs.makeTempDirectoryScoped({ prefix: "studio-fake-vskill-" });
      const executable = path.join(bin, "vskill");
      yield* fs.writeFileString(executable, `#!/bin/sh\n${script}\n`);
      yield* fs.chmod(executable, 0o755);
      return yield* runVskillDoctor({
        cwd: bin,
        environment: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      });
    });

  it.effect("parses a doctor report", () =>
    Effect.gen(function* () {
      const result = yield* withFakeVskill(
        `echo '{"problems":[{"name":"deploy","message":"Broken link."}]}'; exit 1`,
      );
      assert.strictEqual(result.state, "ok");
      assert.deepEqual(result.state === "ok" ? Object.fromEntries(result.findings) : null, {
        deploy: ["Broken link."],
      });
    }),
  );

  it.effect("treats a vskill without doctor as unavailable", () =>
    Effect.gen(function* () {
      const result = yield* withFakeVskill(`echo "error: unknown command 'doctor'" >&2; exit 1`);
      assert.strictEqual(result.state, "unavailable");
    }),
  );

  it.effect("treats a missing vskill as unavailable", () =>
    Effect.gen(function* () {
      const result = yield* runVskillDoctor({
        cwd: process.cwd(),
        environment: { ...process.env, PATH: "/nonexistent-studio-bin" },
      });
      assert.strictEqual(result.state, "unavailable");
    }),
  );
});
