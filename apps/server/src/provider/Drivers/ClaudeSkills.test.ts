import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills, skillOverrideSettingsPaths } from "./ClaudeSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverClaudeSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "codex-review",
        [
          "---",
          "name: codex-review",
          "description: Ask Codex for a review.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "codex-review",
          path: path.join(configDir, "skills", "codex-review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Ask Codex for a review.",
        },
        {
          name: "deploy",
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
      ]);
    }),
  );

  it.effect("ignores .agents/skills, which Claude Code does not load", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      // Verified against the CLI: `/review` here is answered with
      // `Unknown command`, so offering it would dispatch a dead command.
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "review",
        ["---", "name: review", "description: Review the changes.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, []);
    }),
  );

  it.effect("prefers user skills on name collisions even with a stray .agents copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Agents deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Claude deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(configDir, "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "User deploy.",
        },
      ]);
    }),
  );

  it.effect("prefers user skills over project skills on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.scope, "user");
      assert.equal(skills[0]?.description, "User deploy.");
    }),
  );

  it.effect("recovers colon-bearing descriptions with invocation metadata intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      for (const [description, comment] of [
        ["Browser automation + AI test authoring via kane-cli: run browser objectives, ...", ""],
        ['Read C:\\skills\\guide#tag: continue with "quoted".', " # trailing: comment"],
      ] as const) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          "kane-cli",
          [
            "---",
            "name: frontmatter-alias",
            `description: ${description}${comment}`,
            "allowed-tools: [Read, Write]",
            "disable-model-invocation: yes",
            "user-invocable: no",
            "---",
          ].join("\n"),
        );

        const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

        assert.deepEqual(skills, [
          {
            name: "kane-cli",
            path: path.join(configDir, "skills", "kane-cli", "SKILL.md"),
            enabled: true,
            scope: "user",
            description,
            userInvocationOnly: true,
            userInvocable: false,
          },
        ]);
      }
    }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      for (const [directoryName, field] of [
        ["broken-yaml", "name: [unclosed"],
        ["broken-tools", "allowed-tools: [Read, Write"],
        ["broken-quoted", 'name: "unclosed: text'],
      ] as const) {
        yield* writeSkill(
          skillsDir,
          directoryName,
          ["---", "description: Run: browser objectives.", field, "---"].join("\n"),
        );
      }
      // A stray file (not a directory with SKILL.md) must be skipped.
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      // A skill with no frontmatter falls back to its directory name; a skill
      // whose frontmatter fails to parse is skipped entirely (Claude Code
      // won't load it either).
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["no-frontmatter"],
      );
      assert.equal(skills[0]?.description, undefined);
    }),
  );

  it.effect("honors CLAUDE_CONFIG_DIR from the environment when homePath is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const environmentConfigDir = path.join(tempDir, "env-config");

      yield* writeSkill(
        path.join(environmentConfigDir, "skills"),
        "env-skill",
        ["---", "name: env-skill", "description: From env config dir.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["env-skill"],
      );

      // An explicit homePath wins over the environment variable, matching
      // makeClaudeEnvironment which overwrites CLAUDE_CONFIG_DIR for the CLI.
      const explicitHome = path.join(tempDir, "explicit-home");
      yield* writeSkill(
        path.join(explicitHome, "skills"),
        "explicit-skill",
        ["---", "name: explicit-skill", "---"].join("\n"),
      );
      const explicitSkills = yield* discoverClaudeSkills({ homePath: explicitHome }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });
      assert.deepEqual(
        explicitSkills.map((skill) => skill.name),
        ["explicit-skill"],
      );
    }),
  );

  it.effect("resolves a relative CLAUDE_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      // The spawned CLI resolves a relative CLAUDE_CONFIG_DIR against its own
      // cwd (the workspace), so discovery must do the same.
      yield* writeSkill(
        path.join(workspace, "relative-config", "skills"),
        "relative-skill",
        ["---", "name: relative-skill", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, workspace, {
        CLAUDE_CONFIG_DIR: "relative-config",
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["relative-skill"],
      );
      assert.equal(skills[0]?.scope, "user");
    }),
  );

  it.effect("marks skills that only the user can invoke", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "re-release-version",
        [
          "---",
          "name: re-release-version",
          "description: Move the current tag forward.",
          "disable-model-invocation: true",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "release-version",
        ["---", "name: release-version", "description: Cut a release.", "---", "", "# Body"].join(
          "\n",
        ),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.equal(
        skills.find((skill) => skill.name === "re-release-version")?.userInvocationOnly,
        true,
      );
      assert.equal(
        skills.find((skill) => skill.name === "release-version")?.userInvocationOnly,
        undefined,
      );
    }),
  );

  it.effect("disables skills switched off by skillOverrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      for (const name of ["kept", "off-by-user", "off-by-project"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }

      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "off-by-user": "off", "kept": "on" } }',
      );
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{ "skillOverrides": { "off-by-project": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["kept", true],
          ["off-by-project", false],
          ["off-by-user", false],
        ],
      );
    }),
  );

  it.effect("ignores unreadable settings when resolving skillOverrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "kept",
        ["---", "name: kept", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(path.join(configDir, "settings.json"), "{ not json");

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["kept", true]],
      );
    }),
  );

  it.effect("treats a user-invocable-only override like disable-model-invocation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "ask-matt",
        ["---", "name: ask-matt", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "ask-matt": "user-invocable-only" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled, skill.userInvocationOnly === true]),
        [["ask-matt", true, true]],
      );
    }),
  );

  it.effect("drops every override in a file when one value is invalid, as Claude Code does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      for (const name of ["unknown-mode", "boolean-false", "sibling-off"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }
      // Verified against the CLI: with an unknown string or a boolean in the
      // map, the valid "off" sibling is ignored too and every skill runs.
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "unknown-mode": "some-future-mode", "boolean-false": false, "sibling-off": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["boolean-false", true],
          ["sibling-off", true],
          ["unknown-mode", true],
        ],
      );
    }),
  );

  it.effect("reads repository root settings from a nested workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const repo = path.join(tempDir, "repo");
      const workspace = path.join(repo, "packages", "app");

      for (const name of ["root-off", "root-off-cwd-on", "cwd-off-root-on"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(repo, ".claude"), { recursive: true });
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      // The CLI ignores the root's plain settings.json from a nested cwd.
      yield* fs.writeFileString(
        path.join(repo, ".claude", "settings.json"),
        '{ "skillOverrides": { "cwd-off-root-on": "off" } }',
      );
      // The root local file outranks the workspace local file, as in the CLI.
      yield* fs.writeFileString(
        path.join(repo, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "root-off": "off", "root-off-cwd-on": "off", "cwd-off-root-on": "on" } }',
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "root-off-cwd-on": "on", "cwd-off-root-on": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["cwd-off-root-on", true],
          ["root-off", false],
          ["root-off-cwd-on", false],
        ],
      );
    }),
  );

  it.effect("loads project skills from every parent up to the repository root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const outside = path.join(tempDir, "outer");
      const repo = path.join(outside, "repo");
      const packages = path.join(repo, "packages");
      const workspace = path.join(packages, "app");
      const skill = (name: string, description: string) =>
        ["---", `name: ${name}`, `description: ${description}`, "---", "", "# Body"].join("\n");

      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* writeSkill(
        path.join(outside, ".claude", "skills"),
        "above-repo",
        skill("x", "Above."),
      );
      yield* writeSkill(path.join(repo, ".claude", "skills"), "root", skill("root", "Root."));
      yield* writeSkill(path.join(repo, ".claude", "skills"), "shared", skill("s", "Root copy."));
      yield* writeSkill(path.join(packages, ".claude", "skills"), "middle", skill("m", "Middle."));
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "shared",
        skill("s", "Cwd copy."),
      );
      // Below the cwd: loads only after the agent touches files there.
      yield* writeSkill(
        path.join(workspace, "src", ".claude", "skills"),
        "nested",
        skill("nested", "Nested."),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((entry) => [entry.name, entry.scope, entry.description, entry.path]),
        [
          [
            "middle",
            "project",
            "Middle.",
            path.join(packages, ".claude", "skills", "middle", "SKILL.md"),
          ],
          ["root", "project", "Root.", path.join(repo, ".claude", "skills", "root", "SKILL.md")],
          [
            "shared",
            "project",
            "Root copy.",
            path.join(repo, ".claude", "skills", "shared", "SKILL.md"),
          ],
        ],
      );
    }),
  );

  it.effect("loads the main checkout's project skills in a worktree without its own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const main = path.join(tempDir, "main");
      const worktree = path.join(tempDir, "feature");
      const worktreeGitDir = path.join(main, ".git", "worktrees", "feature");
      yield* fs.makeDirectory(worktreeGitDir, { recursive: true });
      yield* fs.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
      yield* fs.makeDirectory(path.join(worktree, "app"), { recursive: true });
      yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
      yield* writeSkill(path.join(main, ".claude", "skills"), "shared", "---\nname: shared\n---\n");
      yield* writeSkill(
        path.join(worktree, "app", ".claude", "skills"),
        "local",
        "---\nname: local\n---\n",
      );
      const home = { homePath: path.join(tempDir, "claude-home") };

      const fallback = yield* discoverClaudeSkills(home, path.join(worktree, "app"));
      assert.deepEqual(
        fallback.map((entry) => [entry.name, entry.path]),
        [
          ["local", path.join(worktree, "app", ".claude", "skills", "local", "SKILL.md")],
          ["shared", path.join(main, ".claude", "skills", "shared", "SKILL.md")],
        ],
      );

      // Once the worktree has its own root skills, the main checkout's are not read.
      yield* writeSkill(path.join(worktree, ".claude", "skills"), "own", "---\nname: own\n---\n");
      const own = yield* discoverClaudeSkills(home, path.join(worktree, "app"));
      assert.deepEqual(
        own.map((entry) => entry.name),
        ["local", "own"],
      );
    }),
  );

  it.effect("loads only the cwd project skills outside a repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const parent = path.join(tempDir, "not-a-repo");
      const workspace = path.join(parent, "workspace");
      yield* writeSkill(
        path.join(parent, ".claude", "skills"),
        "parent",
        ["---", "name: parent", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "own",
        ["---", "name: own", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills(
        { homePath: path.join(tempDir, "claude-home") },
        workspace,
      );

      assert.deepEqual(
        skills.map((entry) => entry.name),
        ["own"],
      );
    }),
  );

  it.effect("ignores ancestor settings outside a repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const parent = path.join(tempDir, "not-a-repo");
      const workspace = path.join(parent, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "kept",
        ["---", "name: kept", "---", "", "# Body"].join("\n"),
      );
      yield* fs.makeDirectory(path.join(parent, ".claude"), { recursive: true });
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.writeFileString(
        path.join(parent, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "kept": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["kept", true]],
      );
    }),
  );

  it.effect("lets the administrator's managed policy outrank every other settings file", () =>
    Effect.gen(function* () {
      // The function is pure on its `path` argument, so hand it the
      // implementation matching each platform under test rather than the
      // host's.
      const path = yield* Path.Path.pipe(Effect.provide(NodePath.layerPosix));
      const win32Path = yield* Path.Path.pipe(Effect.provide(NodePath.layerWin32));

      for (const [platform, expected] of [
        ["darwin", "/Library/Application Support/ClaudeCode/managed-settings.json"],
        ["linux", "/etc/claude-code/managed-settings.json"],
      ] as const) {
        const paths = skillOverrideSettingsPaths(path, "/home/.claude", "/workspace", platform, {});
        assert.deepEqual(paths, [
          "/home/.claude/settings.json",
          "/workspace/.claude/settings.json",
          "/workspace/.claude/settings.local.json",
          expected,
        ]);
      }

      assert.deepEqual(
        skillOverrideSettingsPaths(win32Path, "C:\\Users\\me\\.claude", undefined, "win32", {
          PROGRAMDATA: "C:\\ProgramData",
        }).at(-1),
        "C:\\ProgramData\\ClaudeCode\\managed-settings.json",
      );
      assert.deepEqual(
        skillOverrideSettingsPaths(win32Path, "C:\\Users\\me\\.claude", undefined, "win32", {}),
        ["C:\\Users\\me\\.claude\\settings.json"],
      );

      // Only the repository root's local file joins in, after the
      // workspace's own local file so it wins.
      assert.deepEqual(
        skillOverrideSettingsPaths(
          path,
          "/home/.claude",
          "/repo/packages/app",
          "linux",
          {},
          "/repo",
        ),
        [
          "/home/.claude/settings.json",
          "/repo/packages/app/.claude/settings.json",
          "/repo/packages/app/.claude/settings.local.json",
          "/repo/.claude/settings.local.json",
          "/etc/claude-code/managed-settings.json",
        ],
      );
      // A workspace that is the root itself is not read twice.
      assert.deepEqual(
        skillOverrideSettingsPaths(path, "/home/.claude", "/repo", "linux", {}, "/repo"),
        [
          "/home/.claude/settings.json",
          "/repo/.claude/settings.json",
          "/repo/.claude/settings.local.json",
          "/etc/claude-code/managed-settings.json",
        ],
      );
    }),
  );

  it.effect("records a skill Claude Code keeps out of its own slash commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "agent-only",
        ["---", "name: agent-only", "user-invocable: false", "---", "", "# Body"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.userInvocable]),
        [["agent-only", false]],
      );
    }),
  );

  it.effect("identifies a skill by its directory, as Claude Code does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "probe-alias",
        ["---", "name: probe-alias-frontmatter", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "probe-alias-frontmatter": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      // The frontmatter name is not the command, so an override naming it is
      // not the override Claude Code would apply either.
      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["probe-alias", true]],
      );
    }),
  );

  it.effect("switches a skill off by its directory name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "probe-alias",
        ["---", "name: probe-alias-frontmatter", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "probe-alias": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["probe-alias", false]],
      );
    }),
  );

  it.effect("accepts the YAML 1.1 boolean spellings Claude Code allows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(
        skillsDir,
        "user-only-yes",
        ["---", "disable-model-invocation: yes", "---", "", "# Body"].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "agent-only-no",
        ["---", "user-invocable: no", "---", "", "# Body"].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "plain-off",
        ["---", "disable-model-invocation: off", "---", "", "# Body"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [
          skill.name,
          skill.userInvocationOnly === true,
          skill.userInvocable === false,
        ]),
        [
          ["agent-only-no", false, true],
          ["plain-off", false, false],
          ["user-only-yes", true, false],
        ],
      );
    }),
  );

  it.effect("returns an empty list when no skill roots exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-skills-" });

      const skills = yield* discoverClaudeSkills(
        { homePath: path.join(tempDir, "missing-home") },
        path.join(tempDir, "missing-workspace"),
      );

      assert.deepEqual(skills, []);
    }),
  );
});

const writeJson = Effect.fn(function* (filePath: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, JSON.stringify(value, null, 2));
});

/** A cached plugin version directory, laid out as Claude Code installs it. */
const writePlugin = Effect.fn(function* (
  pluginRoot: string,
  manifest: Record<string, unknown> | undefined,
  skills: Record<string, string>,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(pluginRoot, { recursive: true });
  if (manifest) {
    yield* writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), manifest);
  }
  for (const [relativeDir, contents] of Object.entries(skills)) {
    const skillDir = path.join(pluginRoot, relativeDir);
    yield* fs.makeDirectory(skillDir, { recursive: true });
    yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
  }
});

const pluginEnvironment = {} satisfies NodeJS.ProcessEnv;

it.layer(NodeServices.layer)("discoverClaudeSkills plugin skills", (it) => {
  it.effect("reports enabled plugin skills under their plugin namespace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });
      const pluginsRoot = path.join(configDir, "plugins");
      const swRoot = path.join(pluginsRoot, "cache", "specweave", "sw", "2.1.0");
      const offRoot = path.join(pluginsRoot, "cache", "mkt", "off-plugin", "1.0.0");

      // The cache folder is named after the marketplace entry; components are
      // namespaced under the manifest name.
      yield* writePlugin(
        swRoot,
        { name: "sw", version: "3.0.12" },
        {
          "skills/do": ["---", "description: Work the increment.", "---", "# Do"].join("\n"),
          "skills/renamed": ["---", "name: fancy", "---", "# Fancy"].join("\n"),
          "skills/prefixed": ["---", "name: sw:already", "---", "# Already"].join("\n"),
          "skills/user-only": ["---", "disable-model-invocation: true", "---"].join("\n"),
          "skills/agent-only": ["---", "user-invocable: no", "---"].join("\n"),
          "skills/broken": ["---", "description: [unclosed", "---"].join("\n"),
        },
      );
      yield* writePlugin(offRoot, { name: "off-plugin" }, { "skills/hidden": "# Hidden" });
      yield* writeJson(path.join(pluginsRoot, "installed_plugins.json"), {
        version: 2,
        plugins: {
          "sw@specweave": [{ scope: "user", installPath: swRoot, version: "3.0.12" }],
          "off-plugin@mkt": [{ scope: "user", installPath: offRoot }],
          // Enabled, but its cached copy is gone, so Claude Code cannot load it.
          "gone@mkt": [
            { scope: "user", installPath: path.join(pluginsRoot, "cache", "mkt", "gone", "1") },
          ],
        },
      });
      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: { "sw@specweave": true, "off-plugin@mkt": false, "gone@mkt": true },
      });

      const skills = yield* discoverClaudeSkills(
        { homePath: configDir },
        workspace,
        pluginEnvironment,
      );

      assert.deepEqual(skills, [
        {
          name: "off-plugin:hidden",
          path: path.join(offRoot, "skills", "hidden", "SKILL.md"),
          enabled: false,
          scope: "plugin",
        },
        {
          name: "sw:agent-only",
          path: path.join(swRoot, "skills", "agent-only", "SKILL.md"),
          enabled: true,
          scope: "plugin",
          userInvocable: false,
        },
        {
          name: "sw:already",
          path: path.join(swRoot, "skills", "prefixed", "SKILL.md"),
          enabled: true,
          scope: "plugin",
        },
        {
          name: "sw:do",
          path: path.join(swRoot, "skills", "do", "SKILL.md"),
          enabled: true,
          scope: "plugin",
          description: "Work the increment.",
        },
        {
          name: "sw:fancy",
          path: path.join(swRoot, "skills", "renamed", "SKILL.md"),
          enabled: true,
          scope: "plugin",
        },
        {
          name: "sw:user-only",
          path: path.join(swRoot, "skills", "user-only", "SKILL.md"),
          enabled: true,
          scope: "plugin",
          userInvocationOnly: true,
        },
      ]);
    }),
  );

  it.effect("keeps an enabled namespace ahead of a disabled copy from another marketplace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-plugin-priority-" });
      const configDir = path.join(root, "claude");
      const pluginsRoot = path.join(configDir, "plugins");
      const disabled = path.join(pluginsRoot, "cache", "aaa", "sw", "1");
      const enabled = path.join(pluginsRoot, "cache", "zzz", "sw", "1");
      yield* writePlugin(disabled, { name: "sw" }, { "skills/do": "# Disabled" });
      yield* writePlugin(enabled, { name: "sw" }, { "skills/do": "# Enabled" });
      yield* writeJson(path.join(pluginsRoot, "installed_plugins.json"), {
        plugins: {
          "sw@aaa": [{ scope: "user", installPath: disabled }],
          "sw@zzz": [{ scope: "user", installPath: enabled }],
        },
      });
      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: { "sw@aaa": false, "sw@zzz": true },
      });
      const skills = yield* discoverClaudeSkills(
        { homePath: configDir },
        undefined,
        pluginEnvironment,
      );
      assert.deepEqual(skills, [
        {
          name: "sw:do",
          path: path.join(enabled, "skills", "do", "SKILL.md"),
          scope: "plugin",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("loads project installs only in their own folder and lets local settings win", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");
      const repo = path.join(tempDir, "repo");
      const workspace = path.join(repo, "packages", "app");
      const elsewhere = path.join(tempDir, "elsewhere");
      const pluginsRoot = path.join(configDir, "plugins");
      const mine = path.join(pluginsRoot, "cache", "mkt", "mine", "1.0.0");
      const theirs = path.join(pluginsRoot, "cache", "mkt", "theirs", "1.0.0");
      const optedOut = path.join(pluginsRoot, "cache", "mkt", "opted-out", "1.0.0");
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.makeDirectory(elsewhere, { recursive: true });
      yield* writePlugin(mine, undefined, { "skills/run": "# Run" });
      yield* writePlugin(theirs, undefined, { "skills/run": "# Run" });
      yield* writePlugin(optedOut, undefined, { "skills/run": "# Run" });
      yield* writeJson(path.join(pluginsRoot, "installed_plugins.json"), {
        plugins: {
          // Recorded for the repository root, so it applies to a nested cwd.
          "mine@mkt": [{ scope: "project", projectPath: repo, installPath: mine }],
          // Another project's install with no settings entry here.
          "theirs@mkt": [{ scope: "project", projectPath: elsewhere, installPath: theirs }],
          "opted-out@mkt": [{ scope: "project", projectPath: workspace, installPath: optedOut }],
        },
      });
      yield* writeJson(path.join(workspace, ".claude", "settings.json"), {
        enabledPlugins: { "mine@mkt": true, "opted-out@mkt": true },
      });
      yield* writeJson(path.join(workspace, ".claude", "settings.local.json"), {
        enabledPlugins: { "opted-out@mkt": false },
      });

      const inWorkspace = yield* discoverClaudeSkills(
        { homePath: configDir },
        workspace,
        pluginEnvironment,
      );
      assert.deepEqual(
        inWorkspace.map((skill) => ({ name: skill.name, enabled: skill.enabled })),
        [
          { name: "mine:run", enabled: true },
          { name: "opted-out:run", enabled: false },
        ],
      );

      // Without the workspace settings nothing enables `mine`, and its
      // install is recorded for another folder.
      const inElsewhere = yield* discoverClaudeSkills(
        { homePath: configDir },
        elsewhere,
        pluginEnvironment,
      );
      assert.deepEqual(
        inElsewhere.map((skill) => skill.name),
        ["theirs:run"],
      );
    }),
  );

  it.effect("matches a project install when the workspace is reached through a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");
      const realRepo = path.join(tempDir, "real-repo");
      const linkedRepo = path.join(tempDir, "linked-repo");
      const pluginsRoot = path.join(configDir, "plugins");
      const linked = path.join(pluginsRoot, "cache", "mkt", "linked", "1.0.0");
      yield* fs.makeDirectory(path.join(realRepo, ".git"), { recursive: true });
      yield* fs.symlink(realRepo, linkedRepo);
      yield* writePlugin(linked, undefined, { "skills/run": "# Run" });
      // Claude Code records the physical cwd it was started in.
      yield* writeJson(path.join(pluginsRoot, "installed_plugins.json"), {
        plugins: {
          "linked@mkt": [
            {
              scope: "project",
              projectPath: yield* fs.realPath(realRepo),
              installPath: linked,
            },
          ],
        },
      });

      const skills = yield* discoverClaudeSkills(
        { homePath: configDir },
        `${linkedRepo}/`,
        pluginEnvironment,
      );
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["linked:run"],
      );
    }),
  );

  it.effect("ignores a malformed installed_plugins.json and keeps other skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");
      const pluginsRoot = path.join(configDir, "plugins");
      yield* writePlugin(path.join(configDir, "skills", "mine"), undefined, {});
      yield* fs.writeFileString(path.join(configDir, "skills", "mine", "SKILL.md"), "# Mine");
      for (const contents of [
        "{ not json",
        JSON.stringify({ version: 1, plugins: { "old@mkt": { installPath: pluginsRoot } } }),
        JSON.stringify({ plugins: [] }),
      ]) {
        yield* fs.makeDirectory(pluginsRoot, { recursive: true });
        yield* fs.writeFileString(path.join(pluginsRoot, "installed_plugins.json"), contents);
        const skills = yield* discoverClaudeSkills(
          { homePath: configDir },
          undefined,
          pluginEnvironment,
        );
        assert.deepEqual(
          skills.map((skill) => skill.name),
          ["mine"],
        );
      }
    }),
  );

  it.effect("honours defaultEnabled for an installed plugin with no settings entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");
      const pluginsRoot = path.join(configDir, "plugins");
      const onByDefault = path.join(pluginsRoot, "cache", "mkt", "on", "1");
      const offByDefault = path.join(pluginsRoot, "cache", "mkt", "off", "1");
      yield* writePlugin(onByDefault, { name: "on" }, { "skills/a": "# A" });
      yield* writePlugin(
        offByDefault,
        { name: "off", defaultEnabled: false },
        {
          "skills/b": "# B",
        },
      );
      yield* writeJson(path.join(pluginsRoot, "installed_plugins.json"), {
        plugins: {
          "on@mkt": [{ scope: "user", installPath: onByDefault }],
          "off@mkt": [{ scope: "user", installPath: offByDefault }],
        },
      });

      const skills = yield* discoverClaudeSkills(
        { homePath: configDir },
        undefined,
        pluginEnvironment,
      );

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["on:a"],
      );
    }),
  );

  it.effect("scans manifest skill paths alongside skills/ and drops escaping ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");
      const pluginsRoot = path.join(configDir, "plugins");
      const toolsRoot = path.join(pluginsRoot, "cache", "mkt", "tools", "1");
      const singleRoot = path.join(pluginsRoot, "cache", "mkt", "single", "1");
      yield* writePlugin(
        toolsRoot,
        {
          name: "tools",
          skills: ["./extra-skills/", "./one-skill", "../outside", "no-dot-prefix"],
        },
        {
          "skills/base": "# Base",
          "extra-skills/extra": "# Extra",
          "one-skill": "# One",
          "no-dot-prefix/ignored": "# Ignored",
        },
      );
      yield* writePlugin(path.join(pluginsRoot, "cache", "mkt", "outside"), undefined, {
        escaped: "# Escaped",
      });
      // No skills/ and no `skills` key: the root SKILL.md is the one skill.
      yield* writePlugin(singleRoot, { name: "single" }, { ".": "# Single" });
      yield* writeJson(path.join(pluginsRoot, "installed_plugins.json"), {
        plugins: {
          "tools@mkt": [{ scope: "user", installPath: toolsRoot }],
          "single@mkt": [{ scope: "user", installPath: singleRoot }],
        },
      });
      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: { "tools@mkt": true, "single@mkt": true },
      });

      const skills = yield* discoverClaudeSkills(
        { homePath: configDir },
        undefined,
        pluginEnvironment,
      );

      assert.deepEqual(
        skills.map((skill) => [skill.name, path.relative(pluginsRoot, skill.path)]),
        [
          ["single:single", path.join("cache", "mkt", "single", "1", "SKILL.md")],
          ["tools:base", path.join("cache", "mkt", "tools", "1", "skills", "base", "SKILL.md")],
          [
            "tools:extra",
            path.join("cache", "mkt", "tools", "1", "extra-skills", "extra", "SKILL.md"),
          ],
          ["tools:one-skill", path.join("cache", "mkt", "tools", "1", "one-skill", "SKILL.md")],
        ],
      );
    }),
  );

  it.effect("leaves plugin skills untouched by skillOverrides, as Claude Code does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");
      const pluginsRoot = path.join(configDir, "plugins");
      const swRoot = path.join(pluginsRoot, "cache", "specweave", "sw", "1");
      yield* writePlugin(swRoot, { name: "sw" }, { "skills/do": "# Do" });
      yield* writeSkill(path.join(configDir, "skills"), "do", "# Personal do");
      yield* writeJson(path.join(pluginsRoot, "installed_plugins.json"), {
        plugins: { "sw@specweave": [{ scope: "user", installPath: swRoot }] },
      });
      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: { "sw@specweave": true },
        skillOverrides: { do: "off", "sw:do": "user-invocable-only" },
      });

      const skills = yield* discoverClaudeSkills(
        { homePath: configDir },
        undefined,
        pluginEnvironment,
      );

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.scope, skill.enabled, skill.userInvocationOnly]),
        [
          ["do", "user", false, undefined],
          ["sw:do", "plugin", true, undefined],
        ],
      );
    }),
  );

  it.effect("reads installs from CLAUDE_CODE_PLUGIN_CACHE_DIR when it is set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");
      const pluginsRoot = path.join(tempDir, "plugin-cache");
      const root = path.join(pluginsRoot, "cache", "mkt", "moved", "1");
      yield* writePlugin(root, { name: "moved" }, { "skills/go": "# Go" });
      yield* writeJson(path.join(pluginsRoot, "installed_plugins.json"), {
        plugins: { "moved@mkt": [{ scope: "user", installPath: root }] },
      });
      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: { "moved@mkt": true },
      });

      const withoutOverride = yield* discoverClaudeSkills(
        { homePath: configDir },
        undefined,
        pluginEnvironment,
      );
      assert.deepEqual(withoutOverride, []);

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined, {
        CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginsRoot,
      });
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["moved:go"],
      );
    }),
  );
});
