import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a scratch state folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import { makeSkillRolloutKeep } from "./SkillRolloutKeep.ts";

const projectId = ProjectId.make("project-keep");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const stateDir = () =>
  Effect.promise(async () => {
    const dir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "skill-keep-"));
    dirs.push(dir);
    return dir;
  });

describe("Keep updated on these machines", () => {
  it.effect("keeps one record per skill on this machine and clears it", () =>
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const storePath = join(dir, "skills", "rollout-keep.json");
      const keep = yield* makeSkillRolloutKeep({ storePath });
      const base = {
        projectId,
        repo: "anton-abyzov/vskill",
        skill: "html-report",
        scope: "user",
      } as const;
      yield* keep.change({ ...base, operation: "set", machineIds: ["m5"] });
      const second = yield* keep.change({ ...base, operation: "set", machineIds: ["m5", "m1"] });
      expect(second.records).toHaveLength(1);
      expect(second.records[0]).toMatchObject({
        ...{ repo: base.repo, skill: base.skill },
        machineIds: ["m5", "m1"],
      });
      // Another scope is its own record.
      yield* keep.change({ ...base, scope: "project", operation: "set", machineIds: ["m1"] });
      expect((yield* keep.change({ projectId, operation: "read" })).records).toHaveLength(2);
      // It lives in this machine's state folder only.
      const saved = JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(storePath, "utf8")));
      expect(saved.records).toHaveLength(2);
      const cleared = yield* keep.change({ ...base, operation: "clear" });
      expect(cleared.records.map((record) => record.scope)).toEqual(["project"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads nothing from a damaged file instead of failing", () =>
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const storePath = join(dir, "rollout-keep.json");
      yield* Effect.promise(() => NodeFSP.writeFile(storePath, "{not json"));
      const keep = yield* makeSkillRolloutKeep({ storePath });
      expect((yield* keep.change({ projectId, operation: "read" })).records).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
