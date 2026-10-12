// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";
import * as NetService from "@specweave-studio/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import { vskillContentSha } from "../project/projectSkillsInventory.ts";
import {
  formatProjectSkillsText,
  makeSkillsCommand,
  type skillsCommand,
  type SkillsDiscovery,
} from "./skills.ts";

const claude = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  label: "Claude",
};

const snapshot: ProjectSkillsSnapshot = {
  cwd: "/work/app",
  checkedAt: "2026-10-11T00:00:00.000Z",
  rows: [
    {
      name: "deploy",
      status: "ok",
      attention: false,
      issues: [],
      path: "/work/app/.claude/skills/deploy/SKILL.md",
      scopes: ["project"],
      providers: [
        {
          ...claude,
          path: "/work/app/.claude/skills/deploy/SKILL.md",
          scope: "project",
          enabled: true,
        },
      ],
      lock: null,
      drift: "unlocked",
      copies: 1,
      divergent: false,
      doctor: [],
    },
    {
      name: "review",
      status: "drift",
      attention: true,
      issues: ["SKILL.md differs from the version vskill installed."],
      path: "/work/app/.claude/skills/review/SKILL.md",
      scopes: ["project"],
      providers: [
        {
          ...claude,
          path: "/work/app/.claude/skills/review/SKILL.md",
          scope: "project",
          enabled: true,
        },
      ],
      lock: {
        lockPath: "/work/app/vskill.lock",
        lockScope: "project",
        version: "1.2.0",
        tier: "VERIFIED",
        source: "github:acme/skills",
        sha: "abc",
        installedAt: null,
      },
      drift: "drift",
      copies: 1,
      divergent: false,
      doctor: [],
    },
  ],
  providers: [{ ...claude, state: "ok", skills: 2 }],
  locks: [{ path: "/work/app/vskill.lock", scope: "project", skills: 1 }],
  doctor: "unavailable",
};

describe("formatProjectSkillsText", () => {
  it("prints a summary, one table row per skill and the problems", () => {
    const text = formatProjectSkillsText(snapshot);
    const lines = text.split("\n");
    expect(lines[0]).toBe("/work/app: 2 skills, 1 needs attention");
    expect(lines[2]).toMatch(/^STATUS\s+SKILL\s+PROVIDERS\s+SCOPE\s+VERSION\s+TIER\s+SOURCE$/);
    expect(lines[3]).toMatch(/^ok\s+deploy\s+Claude\s+project\s+-\s+-\s+-$/);
    expect(lines[4]).toMatch(
      /^drift\s+review\s+Claude\s+project\s+1\.2\.0\s+VERIFIED\s+github:acme\/skills$/,
    );
    expect(text).toContain("Needs attention:\n  review (drift)\n    - SKILL.md differs");
    expect(text).toContain("  Claude: 2 skills (ok)");
    expect(text).toContain("  /work/app/vskill.lock (project, 1 skills)");
    expect(text).toContain("vskill doctor: unavailable");
  });

  it("says when no lockfile was found", () => {
    expect(formatProjectSkillsText({ ...snapshot, locks: [] })).toContain(
      "Lockfiles:\n  none found",
    );
  });
});

const cliLayer = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(cliLayer));

const runSkills = (command: typeof skillsCommand, args: ReadonlyArray<string>) =>
  Command.runWith(Command.make("specwithcode").pipe(Command.withSubcommands([command])), {
    version: "0.0.0",
  })(["skills", ...args]).pipe(Effect.provide(cliLayer));

/** A folder with one vskill-installed skill whose SKILL.md was edited afterwards. */
function makeProject() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-skills-cli-")),
  );
  const project = NodePath.join(root, "app");
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  const write = (name: string, content: string) => {
    const folder = NodePath.join(project, ".claude", "skills", name);
    NodeFS.mkdirSync(folder, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(folder, "SKILL.md"), content);
    return NodePath.join(folder, "SKILL.md");
  };
  const deployPath = write("deploy", "---\nname: deploy\n---\nShip it.\n");
  const reviewPath = write("review", "---\nname: review\n---\nEdited by hand.\n");
  NodeFS.writeFileSync(
    NodePath.join(project, "vskill.lock"),
    JSON.stringify({
      skills: {
        deploy: {
          version: "1.0.0",
          tier: "VERIFIED",
          source: "github:acme/deploy",
          sha: vskillContentSha("---\nname: deploy\n---\nShip it.\n"),
          files: ["SKILL.md"],
        },
        review: {
          version: "2.1.0",
          tier: "CERTIFIED",
          source: "github:acme/review",
          sha: vskillContentSha("---\nname: review\n---\nOriginal.\n"),
          files: ["SKILL.md"],
        },
      },
    }),
  );
  const discover: SkillsDiscovery = () =>
    Effect.succeed([
      {
        source: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          label: "Claude",
          skills: [
            { name: "deploy", path: deployPath, scope: "project", enabled: true },
            { name: "review", path: reviewPath, scope: "project", enabled: true },
          ],
        },
        state: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          label: "Claude",
          state: "ok" as const,
          skills: 2,
        },
      },
    ]);
  return { project, home, discover };
}

describe("specwithcode skills", () => {
  it.effect("is registered on the server CLI", () =>
    Effect.gen(function* () {
      yield* runCli(["skills", "--help"]);
      const output = (yield* TestConsole.logLines).join("\n");
      assert.include(output, "List the skills each agent loads in a folder");
      assert.include(output, "--json");
    }),
  );

  it.effect("prints the table for a path, with drift from the project lock", () =>
    Effect.gen(function* () {
      const { project, home, discover } = makeProject();
      const command = makeSkillsCommand({ discover, homeDir: home, doctor: false });
      yield* runSkills(command, [project]);
      const lines = (yield* TestConsole.logLines).join("\n").split("\n");
      expect(lines[0]).toBe(`${project}: 2 skills, 1 needs attention`);
      expect(lines.find((line) => line.startsWith("ok "))).toMatch(
        /^ok\s+deploy\s+Claude\s+project\s+1\.0\.0\s+VERIFIED\s+github:acme\/deploy$/,
      );
      expect(lines.find((line) => line.startsWith("drift "))).toMatch(
        /^drift\s+review\s+Claude\s+project\s+2\.1\.0\s+CERTIFIED\s+github:acme\/review$/,
      );
      expect(lines).toContain(`  ${NodePath.join(project, "vskill.lock")} (project, 2 skills)`);
    }),
  );

  it.effect("prints the same rows as JSON with --json", () =>
    Effect.gen(function* () {
      const { project, home, discover } = makeProject();
      const command = makeSkillsCommand({ discover, homeDir: home, doctor: false });
      yield* runSkills(command, [project, "--json"]);
      const snapshot = JSON.parse(
        (yield* TestConsole.logLines).join("\n"),
      ) as ProjectSkillsSnapshot;
      assert.strictEqual(snapshot.cwd, project);
      assert.deepEqual(
        snapshot.rows.map((row) => [row.name, row.status, row.drift, row.lock?.version]),
        [
          ["deploy", "ok", "match", "1.0.0"],
          ["review", "drift", "drift", "2.1.0"],
        ],
      );
      assert.strictEqual(snapshot.doctor, "unavailable");
    }),
  );
});
