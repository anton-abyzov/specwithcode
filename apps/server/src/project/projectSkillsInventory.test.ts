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
  comparableSkillContent,
  isListableSkillPath,
  lockEntryKey,
  parseVskillDoctorReport,
  parseVskillLock,
  readSkillFrontmatter,
  vskillContentSha,
  type VskillDoctorFinding,
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

const fact = (
  realPath: string,
  content: string | null,
  extra: Partial<SkillFileFact> = {},
): SkillFileFact => ({
  realPath,
  digest: content === null ? null : vskillContentSha(content),
  ...extra,
});

const finding = (skill: string, extra: Partial<VskillDoctorFinding> = {}): VskillDoctorFinding => ({
  skill,
  kind: null,
  message: `${skill} finding`,
  agents: [],
  paths: [],
  ...extra,
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
  it("reads findings with their agents and paths from several report shapes", () => {
    const report = parseVskillDoctorReport(
      JSON.stringify({
        problems: [
          { kind: "divergent", name: "deploy", message: "Two copies differ." },
          { type: "broken-link", path: "/p/.claude/skills/lint" },
          {
            code: "redundant-link",
            paths: ["/p/.agents/skills/lint/SKILL.md"],
            detail: "Redundant.",
            agents: ["cursor"],
          },
        ],
      }),
    );
    assert.deepEqual(
      report?.map((entry) => [entry.skill, entry.kind, entry.message, entry.agents, entry.paths]),
      [
        ["deploy", "divergent", "Two copies differ.", [], []],
        ["lint", "broken-link", "broken-link", [], ["/p/.claude/skills/lint"]],
        ["lint", "redundant-link", "Redundant.", ["cursor"], ["/p/.agents/skills/lint/SKILL.md"]],
      ],
    );
    assert.deepEqual(parseVskillDoctorReport("[]"), []);
    assert.strictEqual(parseVskillDoctorReport("error: unknown command 'doctor'"), undefined);
    assert.strictEqual(parseVskillDoctorReport('{"ok":true}'), undefined);
  });
});

describe("skill file helpers", () => {
  it("reads name and version from frontmatter, nested under metadata too", () => {
    assert.deepEqual(readSkillFrontmatter('---\nname: "gws"\nversion: "1.1.0"\n---\nBody'), {
      name: "gws",
      version: "1.1.0",
    });
    assert.deepEqual(
      readSkillFrontmatter(
        "---\nname: cold-email\nmetadata:\n  author: x\n  version: 2.2.0\n---\n",
      ),
      { name: "cold-email", version: "2.2.0" },
    );
    assert.deepEqual(readSkillFrontmatter("no frontmatter"), { name: null, version: null });
  });

  it("compares copies the way vskill doctor does, ignoring Claude-only fields", () => {
    const shared = "---\nname: review\ndescription: Review.\n---\nBody\n";
    const claude =
      "---\nname: review\nuser-invocable: false\nallowed-tools: Read\ndescription: Review.\n---\nBody\n";
    assert.strictEqual(
      comparableSkillContent(claude, "review"),
      comparableSkillContent(shared, "review"),
    );
    assert.strictEqual(
      comparableSkillContent("---\ndescription: Review.\n---\nBody\n", "review"),
      comparableSkillContent("---\nname: review\ndescription: Review.\n---\nBody\n", "review"),
    );
    assert.notStrictEqual(
      comparableSkillContent(shared.replace("Body", "Other"), "review"),
      comparableSkillContent(shared, "review"),
    );
  });

  it("drops trash folders and plugin command files from catalogs", () => {
    assert.isTrue(isListableSkillPath("/h/.claude/skills/review/SKILL.md"));
    assert.isTrue(isListableSkillPath("/h/.codex/skills/.system/imagegen/SKILL.md"));
    assert.isTrue(isListableSkillPath("/h/.claude/plugins/cache/m/sw/3.0.0/skills/do/SKILL.md"));
    assert.isFalse(isListableSkillPath("/h/.claude/skills/.trash/1-2-x/docs/SKILL.md"));
    assert.isFalse(isListableSkillPath("/h/.agents/skills/.root-owned-social/SKILL.md"));
    assert.isFalse(
      isListableSkillPath("/h/.claude/plugins/marketplaces/o/plugins/codex/commands/setup.md"),
    );
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
      doctor: [],
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
        doctor: [],
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
        doctor: [],
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
        doctor: [],
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
      doctor: [],
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

  it("attaches a plugin install's lock to its namespaced skills", () => {
    const pluginSkill = `${HOME}/.claude/plugins/cache/mkt/frontend/1.0.0/skills/build/SKILL.md`;
    const ownLocked = `${HOME}/.claude/plugins/cache/mkt/frontend/1.0.0/skills/lint/SKILL.md`;
    const otherSkill = `${HOME}/.claude/plugins/cache/mkt/other/1.0.0/skills/build/SKILL.md`;
    const rows = buildProjectSkillRows({
      cwd: CWD,
      providers: [
        provider("claude", "claudeAgent", "Claude", [
          skill("frontend:build", pluginSkill, { scope: "plugin" }),
          skill("frontend:lint", ownLocked, { scope: "plugin" }),
          skill("other:build", otherSkill, { scope: "plugin" }),
        ]),
      ],
      locks: [
        lock("user", {
          frontend: lockEntry({ pluginDir: true, version: "2.0.0", sha: "" }),
          // A standalone skill that shares a plugin skill's folder name is a
          // different skill: it keeps its own row and never claims `frontend:lint`.
          lint: lockEntry({ version: "3.0.0" }),
          // Not a plugin install, so it never claims `other:*` skills.
          other: lockEntry({ version: "4.0.0" }),
        }),
      ],
      files: new Map([
        [pluginSkill, fact(pluginSkill, "x")],
        [ownLocked, fact(ownLocked, "y")],
        [otherSkill, fact(otherSkill, "z")],
      ]),
      doctor: [],
    });
    assert.deepEqual(
      rows.map((row) => [row.name, row.status, row.drift, row.lock?.version ?? null]),
      [
        ["frontend:build", "ok", "unknown", "2.0.0"],
        ["frontend:lint", "ok", "unknown", "2.0.0"],
        ["lint", "missing", "unknown", "3.0.0"],
        ["other", "missing", "unknown", "4.0.0"],
        ["other:build", "ok", "unlocked", null],
      ],
    );
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
      doctor: [],
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
      doctor: [finding("fine", { message: "Description is too long." })],
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

  it("joins presences of one file before names, keeping other names as aliases", () => {
    const store = `${HOME}/.agents/skills/apify-data-gathering/SKILL.md`;
    const claudeLink = `${HOME}/.claude/skills/apify-data-gathering/SKILL.md`;
    const content = "---\nname: marketing/apify-data-gathering\n---\nBody\n";
    const rows = buildProjectSkillRows({
      cwd: CWD,
      providers: [
        provider("claude", "claudeAgent", "Claude", [
          skill("apify-data-gathering", claudeLink, { scope: "user" }),
        ]),
        provider("codex", "codex", "Codex", [
          skill("marketing/apify-data-gathering", store, { scope: "user" }),
        ]),
        provider("grok", "grok", "Grok", [
          skill("marketing-apify-data-gathering", store, { scope: "user" }),
        ]),
      ],
      locks: [lock("user", { "apify-data-gathering": lockEntry() })],
      files: new Map([
        [claudeLink, fact(store, content, { frontmatterName: "marketing/apify-data-gathering" })],
        [store, fact(store, content, { frontmatterName: "marketing/apify-data-gathering" })],
      ]),
      doctor: [],
    });
    assert.deepEqual(
      rows.map((row) => row.name),
      ["apify-data-gathering"],
    );
    assert.deepEqual(rows[0]!.aliases, [
      "marketing-apify-data-gathering",
      "marketing/apify-data-gathering",
    ]);
    assert.strictEqual(rows[0]!.copies, 1);
    assert.strictEqual(rows[0]!.lock?.version, "1.0.0");
    assert.deepEqual(
      rows[0]!.providers.map((presence) => [presence.label, presence.name ?? null]),
      [
        ["Claude", null],
        ["Codex", "marketing/apify-data-gathering"],
        ["Grok", "marketing-apify-data-gathering"],
      ],
    );
  });

  it("joins a plugin skill listed bare by one agent and reports version skew", () => {
    const claudeCopy = `${HOME}/.claude/plugins/cache/specweave/sw/3.0.23/skills/do/SKILL.md`;
    const codexCopy = `${HOME}/.codex/plugins/cache/specweave/sw/3.0.20/skills/do/SKILL.md`;
    const rows = buildProjectSkillRows({
      cwd: CWD,
      providers: [
        provider("claude", "claudeAgent", "Claude", [
          skill("sw:do", claudeCopy, { scope: "plugin" }),
        ]),
        provider("grok", "grok", "Grok", [skill("do", claudeCopy, { scope: "plugin" })]),
        provider("codex", "codex", "Codex", [skill("sw:do", codexCopy, { scope: "user" })]),
      ],
      locks: [],
      files: new Map([
        [claudeCopy, fact(claudeCopy, "new\n", { fileVersion: "3.0.0", pluginVersion: "3.0.23" })],
        [codexCopy, fact(codexCopy, "old\n", { fileVersion: "3.0.0", pluginVersion: "3.0.20" })],
      ]),
      doctor: [],
    });
    assert.strictEqual(rows.length, 1);
    const row = rows[0]!;
    assert.strictEqual(row.name, "sw:do");
    assert.deepEqual(row.aliases, ["do"]);
    assert.strictEqual(row.status, "duplicate");
    assert.strictEqual(row.copies, 2);
    assert.match(row.issues[0] ?? "", /Claude, Grok 3\.0\.23; Codex 3\.0\.20/);
    assert.deepEqual(
      row.providers.map((presence) => [presence.label, presence.pluginVersion]),
      [
        ["Claude", "3.0.23"],
        ["Codex", "3.0.20"],
        ["Grok", "3.0.23"],
      ],
    );
  });

  it("treats copies that differ only in Claude-only frontmatter as identical", () => {
    const claudeCopy = `${HOME}/.claude/skills/review/SKILL.md`;
    const shared = `${HOME}/.agents/skills/review/SKILL.md`;
    const row = buildProjectSkillRows({
      cwd: CWD,
      providers: [
        provider("claude", "claudeAgent", "Claude", [
          skill("review", claudeCopy, { scope: "user" }),
        ]),
        provider("codex", "codex", "Codex", [skill("review", shared, { scope: "user" })]),
      ],
      locks: [],
      files: new Map([
        [claudeCopy, fact(claudeCopy, "claude\n", { comparableDigest: "same" })],
        [shared, fact(shared, "shared\n", { comparableDigest: "same" })],
      ]),
      doctor: [],
    })[0]!;
    assert.strictEqual(row.status, "ok");
    assert.strictEqual(row.divergent, false);
    assert.strictEqual(row.attention, false);
    assert.match(row.issues[0] ?? "", /2 identical copies/);
  });

  it("counts doctor findings only for agents and folders in the snapshot", () => {
    const claudeCopy = `${HOME}/.claude/skills/media/SKILL.md`;
    const shared = `${HOME}/.agents/skills/media/SKILL.md`;
    const build = (doctor: ReadonlyArray<VskillDoctorFinding>) =>
      buildProjectSkillRows({
        cwd: CWD,
        providers: [
          provider("claude", "claudeAgent", "Claude", [
            skill("media", claudeCopy, { scope: "user" }),
          ]),
          provider("grok", "grok", "Grok", [skill("media", shared, { scope: "user" })]),
        ],
        locks: [],
        files: new Map([
          [claudeCopy, fact(shared, "x")],
          [shared, fact(shared, "x")],
        ]),
        doctor,
      })[0]!;
    const other = build([
      finding("media", {
        kind: "redundant-link",
        agents: ["cursor"],
        paths: [`${HOME}/.cursor/skills/media`],
      }),
      finding("media", { kind: "redundant-link", agents: ["gemini-cli"] }),
      finding("media", { kind: "identical-copy", paths: [`${HOME}/.copilot/skills/media`] }),
    ]);
    assert.strictEqual(other.attention, false);
    assert.deepEqual(other.doctor, []);
    const own = build([
      finding("media", { message: "claude link", agents: ["claude-code"] }),
      finding("media", { message: "own folder", paths: [`${HOME}/.agents/skills/media`] }),
      finding("media", { message: "no detail" }),
    ]);
    assert.strictEqual(own.attention, true);
    assert.deepEqual(own.doctor, ["claude link", "own folder", "no detail"]);
  });

  it("shows doctor's identical-copy finding in place of the app's own", () => {
    const claudeCopy = `${HOME}/.claude/skills/media/SKILL.md`;
    const shared = `${HOME}/.agents/skills/media/SKILL.md`;
    const row = buildProjectSkillRows({
      cwd: CWD,
      providers: [
        provider("claude", "claudeAgent", "Claude", [
          skill("media", claudeCopy, { scope: "user" }),
        ]),
        provider("codex", "codex", "Codex", [skill("media", shared, { scope: "user" })]),
      ],
      locks: [],
      files: new Map([
        [claudeCopy, fact(claudeCopy, "x")],
        [shared, fact(shared, "x")],
      ]),
      doctor: [
        finding("media", {
          kind: "identical-copy",
          message: "2 byte-identical copies, keep the shared one",
          paths: [`${HOME}/.claude/skills/media`, `${HOME}/.agents/skills/media`],
        }),
      ],
    })[0]!;
    assert.strictEqual(row.status, "ok");
    assert.strictEqual(row.attention, true);
    assert.deepEqual(row.issues, ["2 byte-identical copies, keep the shared one"]);
  });

  it("marks lock entries with nothing on disk as stale, without attention", () => {
    const userLock = lock("user", {
      gone: lockEntry(),
      parked: lockEntry(),
    });
    const rows = buildProjectSkillRows({
      cwd: CWD,
      providers: [],
      locks: [userLock],
      files: new Map(),
      doctor: [finding("gone", { kind: "lock-missing", message: "nothing on disk" })],
      lockOnDisk: new Set([lockEntryKey(userLock.path, "parked")]),
    });
    const [gone, parked] = rows;
    assert.strictEqual(gone?.status, "missing");
    assert.strictEqual(gone?.staleLock, true);
    assert.strictEqual(gone?.attention, false);
    assert.match(gone?.issues[0] ?? "", /Stale lock entry/);
    assert.strictEqual(parked?.staleLock, undefined);
    assert.strictEqual(parked?.attention, true);
  });

  it("keeps skills an agent hides from its slash menu enabled", () => {
    const path = `${HOME}/.grok/bundled/skills/pdf/SKILL.md`;
    const row = buildProjectSkillRows({
      cwd: CWD,
      providers: [
        provider("grok", "grok", "Grok", [
          skill("pdf", path, { scope: "bundled", userInvocable: false }),
        ]),
      ],
      locks: [],
      files: new Map(),
      doctor: [],
    })[0]!;
    assert.strictEqual(row.status, "ok");
    assert.strictEqual(row.attention, false);
    assert.strictEqual(row.providers[0]?.userInvocable, false);
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

it.layer(NodeServices.layer)("gatherProjectSkills versions and catalogs", (it) => {
  it.effect("reads file and plugin versions, drops trash, marks stale lock entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "studio-project-skills-v-" });
      const home = path.join(temp, "home");
      const project = path.join(temp, "project");
      yield* fs.makeDirectory(project, { recursive: true });
      const plugin = path.join(home, ".claude", "plugins", "cache", "specweave", "sw", "3.0.23");
      const pluginSkill = path.join(plugin, "skills", "do", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(pluginSkill), { recursive: true });
      yield* fs.makeDirectory(path.join(plugin, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(pluginSkill, "---\ndescription: Do.\nversion: 3.0.0\n---\nDo.\n");
      yield* fs.writeFileString(
        path.join(plugin, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "sw", version: "3.0.23" }),
      );
      const trashed = path.join(home, ".claude", "skills", ".trash", "1-x", "docs", "SKILL.md");
      const parked = path.join(home, ".agents", "skills", "parked");
      yield* fs.makeDirectory(parked, { recursive: true });
      yield* fs.writeFileString(
        path.join(home, ".agents", "vskill.lock"),
        JSON.stringify({ skills: { gone: { version: "1.0.0" }, parked: { version: "1.0.0" } } }),
      );

      const snapshot = yield* gatherProjectSkills({
        cwd: project,
        homeDir: home,
        doctor: false,
        providers: [
          provider("claude", "claudeAgent", "Claude", [
            skill("sw:do", pluginSkill, { scope: "plugin" }),
          ]),
          provider("grok", "grok", "Grok", [
            skill("do", pluginSkill, { scope: "plugin" }),
            skill("docs", trashed, { scope: "user" }),
          ]),
        ],
        providerStates: [
          {
            instanceId: ProviderInstanceId.make("grok"),
            driver: ProviderDriverKind.make("grok"),
            label: "Grok",
            state: "ok",
            skills: 2,
          },
        ],
      });
      assert.deepEqual(
        snapshot.rows.map((row) => [row.name, row.status, row.attention, row.staleLock ?? false]),
        [
          ["gone", "missing", false, true],
          ["parked", "missing", true, false],
          ["sw:do", "ok", false, false],
        ],
      );
      const swDo = snapshot.rows.find((row) => row.name === "sw:do")!;
      assert.deepEqual(swDo.aliases, ["do"]);
      assert.deepEqual(
        swDo.providers.map((presence) => [presence.fileVersion, presence.pluginVersion]),
        [
          ["3.0.0", "3.0.23"],
          ["3.0.0", "3.0.23"],
        ],
      );
      assert.strictEqual(snapshot.providers[0]?.skills, 1);
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
      assert.deepEqual(
        result.state === "ok" ? result.findings.map((entry) => [entry.skill, entry.message]) : null,
        [["deploy", "Broken link."]],
      );
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
