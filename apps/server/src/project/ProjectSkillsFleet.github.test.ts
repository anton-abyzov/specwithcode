import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type ProjectSkillsFleetPushInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type { FleetSkillAsk, FleetSkillOutcome } from "../fleet/fleetSkills.ts";
import type { FleetLink } from "../fleet/fleetTransport.ts";
import type { FleetTarget } from "../studioFleet.ts";
import { type FleetPushDeps, fleetPushResultOf, pushSkillToFleet } from "./ProjectSkillsFleet.ts";

const projectId = ProjectId.make("project-skills-rollout");
const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);
const github = {
  kind: "github",
  path: "skills/html-report/SKILL.md",
  branch: "main",
  commit: COMMIT,
} as const;

const machine = (id: string): FleetTarget => ({
  id,
  label: id.toUpperCase(),
  environmentId: EnvironmentId.make(`env-${id}`),
  url: `http://${id}.tailnet:8319`,
  scopes: [] as never,
});

const deps = (options: {
  readonly asks: Array<{ targets: ReadonlyArray<string>; ask: FleetSkillAsk }>;
  readonly verified?: string | null;
  readonly answer?: (target: FleetTarget, ask: FleetSkillAsk) => FleetSkillOutcome;
}): FleetPushDeps => ({
  loadFleet: () =>
    Effect.succeed({
      machines: [machine("m5"), machine("linux"), machine("m1")],
      link: {} as FleetLink,
    }),
  coordinatorEnvironmentId: Effect.succeed("env-m4"),
  runInstalls: async (input) => {
    options.asks.push({ targets: input.targets.map((target) => target.id), ask: input.ask });
    return input.targets.map(
      (target) =>
        options.answer?.(target, input.ask) ?? {
          machine: target.id,
          label: target.label,
          result: "installed",
          installedVersion: input.ask.version,
          via: "vskill",
          previous: null,
          removed: false,
        },
    );
  },
  // The registry never lists a GitHub source; it must not be asked.
  registryVersions: () => Effect.die("the registry was asked about a GitHub source"),
  lockedVersions: () => Effect.succeed([]),
  verifyGithubSource: () =>
    Effect.succeed(options.verified === undefined ? null : options.verified),
});

const input = (fields: Partial<ProjectSkillsFleetPushInput> = {}) =>
  ({
    projectId,
    skillId: "anton-abyzov/vskill/html-report",
    version: "1.1.3",
    pin: false,
    contentHash: HASH,
    github,
    targets: [{ machineId: "m5", scope: "user" }],
    ...fields,
  }) as ProjectSkillsFleetPushInput;

describe("Also add on from a connected GitHub repo", () => {
  it.effect("sends the commit and its content hash instead of asking the registry", () =>
    Effect.gen(function* () {
      const asks: Array<{ targets: ReadonlyArray<string>; ask: FleetSkillAsk }> = [];
      const result = yield* pushSkillToFleet(deps({ asks }), input({ preview: true }));
      expect(asks).toHaveLength(1);
      expect(asks[0]!.ask).toMatchObject({
        skill: "anton-abyzov/vskill/html-report",
        source: github,
        contentHash: HASH,
        preview: true,
        scope: "user",
      });
      expect(result.results[0]).toMatchObject({ machineId: "m5", ok: true, via: "vskill" });
    }),
  );

  it.effect("refuses before sending anything when this machine cannot read that copy itself", () =>
    Effect.gen(function* () {
      const asks: Array<{ targets: ReadonlyArray<string>; ask: FleetSkillAsk }> = [];
      const error = yield* pushSkillToFleet(
        deps({ asks, verified: "anton-abyzov/vskill is not connected on this machine." }),
        input(),
      ).pipe(Effect.flip);
      expect(error.reason).toBe("version_not_found");
      expect(error.detail).toMatch(/not connected/);
      expect(asks).toHaveLength(0);
    }),
  );

  it.effect("needs the content hash with a GitHub source", () =>
    Effect.gen(function* () {
      const asks: Array<{ targets: ReadonlyArray<string>; ask: FleetSkillAsk }> = [];
      const error = yield* pushSkillToFleet(deps({ asks }), input({ contentHash: undefined })).pipe(
        Effect.flip,
      );
      expect(error.reason).toBe("version_not_found");
      expect(asks).toHaveLength(0);
    }),
  );

  it.effect("keeps one result per machine when some machines fail (partial failure)", () =>
    Effect.gen(function* () {
      const asks: Array<{ targets: ReadonlyArray<string>; ask: FleetSkillAsk }> = [];
      const result = yield* pushSkillToFleet(
        deps({
          asks,
          answer: (target, ask) =>
            target.id === "m5"
              ? {
                  machine: "m5",
                  label: "M5",
                  result: "installed",
                  installedVersion: ask.version,
                  via: "npx",
                  previous: null,
                  removed: false,
                }
              : target.id === "linux"
                ? { machine: "linux", error: "No GitHub access to the repo.", reason: "no-access" }
                : { machine: "m1", error: "m1 is offline.", reason: "unreachable" },
        }),
        input({
          targets: [
            { machineId: "m5", scope: "user", expectedHash: "x" },
            { machineId: "linux", scope: "user", expectedHash: "y" },
            { machineId: "m1", scope: "user", expectedHash: "z" },
          ],
        }),
      );
      expect(result.results.map((entry) => [entry.machineId, entry.ok, entry.reason])).toEqual([
        ["m5", true, undefined],
        ["linux", false, "no-access"],
        ["m1", false, "unreachable"],
      ]);
      expect(result.results[0]!.via).toBe("npx");
      // Each reviewed machine keeps its own fingerprint: three asks, one per machine.
      expect(asks.map((entry) => entry.targets)).toEqual([["m5"], ["linux"], ["m1"]]);
    }),
  );

  it.effect("passes Undo of a new install on as a removal of that copy", () =>
    Effect.gen(function* () {
      const asks: Array<{ targets: ReadonlyArray<string>; ask: FleetSkillAsk }> = [];
      yield* pushSkillToFleet(deps({ asks }), input({ action: "remove" }));
      expect(asks[0]!.ask).toMatchObject({ action: "remove", contentHash: HASH, source: github });
    }),
  );

  it("maps a machine's answer to its result row", () => {
    expect(
      fleetPushResultOf("m5", {
        machine: "m5",
        result: "preview",
        expectedHash: "fp",
        installedVersion: "1.1.2",
        files: ["/home/u/.agents/skills/html-report/SKILL.md"],
        via: "npx",
        previous: { version: "1.1.2", commit: null, contentHash: null, branch: null, path: null },
      }),
    ).toMatchObject({
      ok: true,
      preview: true,
      files: ["/home/u/.agents/skills/html-report/SKILL.md"],
      via: "npx",
      previous: { version: "1.1.2" },
    });
    expect(
      fleetPushResultOf("m5", { machine: "m5", result: "installed", removed: true, via: "vskill" }),
    ).toMatchObject({ ok: true, removed: true });
  });
});
