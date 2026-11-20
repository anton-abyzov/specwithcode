/**
 * A Claude skill folder that is there but cannot be read must leave the scan
 * marked incomplete, so the Skills page says "unknown" for it and never
 * "Not on <machine>". The failure is injected through the FileSystem service.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { providerSkillsForCwd } from "../../project/ProjectSkillsService.ts";
import { upsertProviderWorkspaceSnapshot } from "../ProviderRegistry.ts";
import { discoverClaudeSkillsReport } from "./ClaudeSkills.ts";

const SKILL = ["---", "name: ok", "description: Readable.", "---", "", "# Body"].join("\n");

const denied = (method: string, target: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: target,
  });

/** The real filesystem, except paths containing `blocked` refuse with EACCES. */
const withBlocked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const blocked: FileSystem.FileSystem = {
      ...fs,
      readDirectory: (target, options) =>
        target.includes("blocked")
          ? Effect.fail(denied("readDirectory", target))
          : fs.readDirectory(target, options),
      readFileString: (target, encoding) =>
        target.includes("blocked")
          ? Effect.fail(denied("readFileString", target))
          : fs.readFileString(target, encoding),
    };
    return yield* effect.pipe(Effect.provideService(FileSystem.FileSystem, blocked));
  });

it.layer(NodeServices.layer)("discoverClaudeSkillsReport", (it) => {
  it.effect("marks the scan incomplete when a skill's SKILL.md cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-incomplete-" });
      const skills = path.join(temp, "home", "skills");
      for (const name of ["ok", "blocked-skill"]) {
        yield* fs.makeDirectory(path.join(skills, name), { recursive: true });
        yield* fs.writeFileString(path.join(skills, name, "SKILL.md"), SKILL);
      }
      // A plain file and a folder without SKILL.md are not skills, and not a failed read.
      yield* fs.writeFileString(path.join(skills, "README.md"), "notes");
      yield* fs.makeDirectory(path.join(skills, "empty"));

      const report = yield* withBlocked(
        discoverClaudeSkillsReport({ homePath: path.join(temp, "home") }, undefined, {}),
      );
      assert.deepEqual(
        report.skills.map((skill) => skill.name),
        ["ok"],
      );
      assert.strictEqual(report.incomplete, true);
    }),
  );

  it.effect("marks the scan incomplete when the skills folder cannot be listed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-incomplete-" });
      const home = path.join(temp, "blocked-home");
      yield* fs.makeDirectory(path.join(home, "skills"), { recursive: true });
      const report = yield* withBlocked(
        discoverClaudeSkillsReport({ homePath: home }, undefined, {}),
      );
      assert.strictEqual(report.incomplete, true);
    }),
  );

  it.effect("marks the scan incomplete when a synced claude.ai skill cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-incomplete-" });
      const bucket = path.join(temp, "home", "skills", "synced", "bucket");
      yield* fs.makeDirectory(path.join(bucket, "blocked-sync"), { recursive: true });
      yield* fs.writeFileString(path.join(bucket, "blocked-sync", "SKILL.md"), SKILL);
      const report = yield* withBlocked(
        discoverClaudeSkillsReport({ homePath: path.join(temp, "home") }, undefined, {}),
      );
      assert.strictEqual(report.incomplete, true);
    }),
  );

  it.effect("a missing folder, plain files and empty folders leave the scan complete", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-incomplete-" });
      const missing = yield* discoverClaudeSkillsReport(
        { homePath: path.join(temp, "nowhere") },
        undefined,
        {},
      );
      assert.strictEqual(missing.incomplete, false);
      const skills = path.join(temp, "home", "skills");
      yield* fs.makeDirectory(path.join(skills, "empty"), { recursive: true });
      yield* fs.writeFileString(path.join(skills, "README.md"), "notes");
      const plain = yield* discoverClaudeSkillsReport(
        { homePath: path.join(temp, "home") },
        undefined,
        {},
      );
      assert.strictEqual(plain.incomplete, false);
      assert.deepEqual(plain.skills, []);
    }),
  );
});

it("carries the incomplete scan from the workspace snapshot to the Skills page", () => {
  const provider = {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    status: "ready",
    checkedAt: "2026-01-01T00:00:00.000Z",
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
  const scanned = upsertProviderWorkspaceSnapshot(provider, "/work/app", {
    ...provider,
    skillsIncomplete: true,
  });
  assert.strictEqual(scanned.workspaceSnapshots?.[0]?.skillsIncomplete, true);
  const state = providerSkillsForCwd(scanned, "/work/app", "done").state;
  assert.strictEqual(state.state, "ok");
  assert.strictEqual(state.incomplete, true);

  const complete = upsertProviderWorkspaceSnapshot(scanned, "/work/app", provider);
  assert.strictEqual(complete.workspaceSnapshots?.[0]?.skillsIncomplete, undefined);
  assert.strictEqual(
    providerSkillsForCwd(complete, "/work/app", "done").state.incomplete,
    undefined,
  );

  // The machine-wide list carries its own flag when no folder was scanned.
  const machine = providerSkillsForCwd(
    { ...provider, skillsIncomplete: true },
    "/elsewhere",
    "done",
  );
  assert.strictEqual(machine.state.incomplete, true);
});
