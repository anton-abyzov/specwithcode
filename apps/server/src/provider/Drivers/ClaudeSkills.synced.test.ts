import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { isBuiltInAgentSkill, isListableSkillPath } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills } from "./ClaudeSkills.ts";

const skillFile = (name: string, description: string) =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", "# Body"].join("\n");

const writeFile = Effect.fn(function* (file: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, contents);
});

it.layer(NodeServices.layer)("discoverClaudeSkills, claude.ai-synced skills", (it) => {
  it.effect("lists a home that holds only synced skills, read-only under claude.ai", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-synced-" });
      const configDir = path.join(tempDir, "claude-home");
      const bucket = path.join(configDir, "skills", "synced", "account-a_org-a");
      yield* writeFile(path.join(bucket, "morning", "SKILL.md"), skillFile("morning", "Brief."));
      yield* writeFile(path.join(bucket, "pdf", "SKILL.md"), skillFile("pdf", "Read PDFs."));
      yield* writeFile(path.join(bucket, "manifest.json"), JSON.stringify({ lastUpdated: 5 }));
      // The sync's own bookkeeping is never a skill.
      yield* writeFile(path.join(configDir, "skills", "synced", ".bucket-account-a_org-a"), "");
      yield* writeFile(
        path.join(bucket, ".staging", "1", ".replaced-1", "SKILL.md"),
        skillFile("stale", "Replaced."),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined, {});

      assert.deepEqual(skills, [
        {
          name: "anthropic-skills:morning",
          path: path.join(bucket, "morning", "SKILL.md"),
          enabled: true,
          scope: "claude.ai",
          description: "Brief.",
        },
        {
          name: "anthropic-skills:pdf",
          path: path.join(bucket, "pdf", "SKILL.md"),
          enabled: true,
          scope: "claude.ai",
          description: "Read PDFs.",
        },
      ]);
      for (const skill of skills) {
        assert.isTrue(isListableSkillPath(skill.path));
        assert.isTrue(isBuiltInAgentSkill(skill));
      }
    }),
  );

  it.effect("lists a name found in several buckets once, from the latest sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-synced-" });
      const configDir = path.join(tempDir, "claude-home");
      const synced = path.join(configDir, "skills", "synced");
      yield* writeFile(path.join(synced, "a_old", "docx", "SKILL.md"), skillFile("docx", "Old."));
      yield* writeFile(path.join(synced, "a_old", "manifest.json"), '{"lastUpdated":10}');
      yield* writeFile(path.join(synced, "b_new", "docx", "SKILL.md"), skillFile("docx", "New."));
      yield* writeFile(path.join(synced, "b_new", "manifest.json"), '{"lastUpdated":20}');
      // No manifest: still listed, and it never displaces a dated bucket.
      yield* writeFile(path.join(synced, "c_bare", "docx", "SKILL.md"), skillFile("docx", "Bare."));
      yield* writeFile(path.join(synced, "c_bare", "xlsx", "SKILL.md"), skillFile("xlsx", "Sheets."));

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined, {});

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description, skill.path]),
        [
          ["anthropic-skills:docx", "New.", path.join(synced, "b_new", "docx", "SKILL.md")],
          ["anthropic-skills:xlsx", "Sheets.", path.join(synced, "c_bare", "xlsx", "SKILL.md")],
        ],
      );
    }),
  );

  it.effect("keeps the user's own skill of the same folder name as a separate entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-synced-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");
      yield* writeFile(path.join(skillsDir, "pdf", "SKILL.md"), skillFile("pdf", "Mine."));
      yield* writeFile(
        path.join(skillsDir, "synced", "a_b", "pdf", "SKILL.md"),
        skillFile("pdf", "Synced."),
      );
      // skillOverrides name the user's skill; a synced one is not switched here.
      yield* writeFile(
        path.join(configDir, "settings.json"),
        JSON.stringify({ skillOverrides: { pdf: "off", "anthropic-skills:pdf": "off" } }),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined, {});

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.scope, skill.enabled]),
        [
          ["anthropic-skills:pdf", "claude.ai", true],
          ["pdf", "user", false],
        ],
      );
    }),
  );
});

it("marks Codex system skills as built in, and nothing a person installed", () => {
  assert.isTrue(isBuiltInAgentSkill({ scope: "system", path: "/h/.codex/skills/.system/x/SKILL.md" }));
  assert.isTrue(isBuiltInAgentSkill({ scope: null, path: "/h/.codex/skills/.system/x/SKILL.md" }));
  assert.isTrue(
    isBuiltInAgentSkill({ scope: null, path: "C:\\h\\.codex\\skills\\.system\\x\\SKILL.md" }),
  );
  assert.isFalse(isBuiltInAgentSkill({ scope: "user", path: "/h/.claude/skills/x/SKILL.md" }));
  assert.isFalse(isBuiltInAgentSkill({ scope: "plugin", path: "/h/.claude/plugins/cache/x/SKILL.md" }));
});
