import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type ProjectSkillsFleetPushInput,
  type ProjectSkillsStudioLinkInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Studio runtime locks in a temporary HOME.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import type { FleetSkillAsk, FleetSkillOutcome } from "../fleet/fleetSkills.ts";
import type { FleetLink } from "../fleet/fleetTransport.ts";
import { join } from "../nodePath.ts";
import type { FleetTarget } from "../studioFleet.ts";
import {
  type FleetPushDeps,
  fleetPushResultOf,
  makeStudioLink,
  parseStudioLock,
  pushSkillToFleet,
  studioSkillUrl,
} from "./ProjectSkillsFleet.ts";

const projectId = ProjectId.make("project-skills-fleet");
const skillId = "anton-abyzov/vskill/sw-do";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const tempDir = (prefix: string) =>
  Effect.promise(async () => {
    const dir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  });
const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(join(file, ".."), { recursive: true });
    await NodeFSP.writeFile(file, text);
  });

const machine = (id: string): FleetTarget => ({
  id,
  label: id.toUpperCase(),
  environmentId: EnvironmentId.make(`env-${id}`),
  url: `http://${id}.tailnet:8319`,
  scopes: [] as never,
});

interface PushCall {
  readonly targets: ReadonlyArray<string>;
  readonly ask: FleetSkillAsk;
  readonly coordinatorEnvironmentId: string;
}

const pushDeps = (options: {
  readonly machines?: ReadonlyArray<FleetTarget> | null;
  readonly registry?: ReadonlyArray<string> | undefined;
  readonly locked?: ReadonlyArray<{ skillId: string; version: string }>;
  readonly answer?: (target: FleetTarget, ask: FleetSkillAsk) => FleetSkillOutcome;
  readonly calls: Array<PushCall>;
}): FleetPushDeps => ({
  loadFleet: () =>
    Effect.succeed(
      options.machines === null
        ? null
        : {
            machines: options.machines ?? [machine("m1"), machine("m3"), machine("m4")],
            link: {} as FleetLink,
          },
    ),
  coordinatorEnvironmentId: Effect.succeed("env-coordinator"),
  runInstalls: async (input) => {
    options.calls.push({
      targets: input.targets.map((target) => target.id),
      ask: input.ask,
      coordinatorEnvironmentId: input.coordinatorEnvironmentId,
    });
    return input.targets.map((target) =>
      options.answer
        ? options.answer(target, input.ask)
        : {
            machine: target.id,
            label: target.label,
            result: "installed",
            installedVersion: input.ask.version,
            pinnedVersion: input.ask.pin ? input.ask.version : null,
          },
    );
  },
  registryVersions: () => Effect.succeed(options.registry),
  lockedVersions: () => Effect.succeed(options.locked ?? []),
});

const push = (
  targets: ProjectSkillsFleetPushInput["targets"],
  fields: Partial<ProjectSkillsFleetPushInput> = {},
) =>
  ({
    projectId,
    skillId,
    version: "1.2.0",
    pin: true,
    targets,
    ...fields,
  }) as ProjectSkillsFleetPushInput;
const user = (machineId: string) => ({ machineId, scope: "user" }) as never;
const inProject = (machineId: string, id: string) =>
  ({ machineId, scope: "project", projectId: id }) as never;

describe("pushSkillToFleet", () => {
  it.effect("asks once per scope, naming each project by its id, and answers in order", () =>
    Effect.gen(function* () {
      const calls: Array<PushCall> = [];
      const result = yield* pushSkillToFleet(
        pushDeps({
          calls,
          registry: ["1.2.0", "1.1.0"],
          answer: (target, ask) =>
            target.id === "m3"
              ? {
                  machine: target.id,
                  label: target.label,
                  reason: "unauthorized",
                  error: "fleet:skills is not granted.",
                }
              : {
                  machine: target.id,
                  label: target.label,
                  result: "installed",
                  installedVersion: ask.version,
                  pinnedVersion: ask.version,
                },
        }),
        push([inProject("m4", "proj-b"), user("m1"), inProject("m3", "proj-a")]),
      );
      expect(result.results).toEqual([
        {
          machineId: "m4",
          label: "M4",
          ok: true,
          installedVersion: "1.2.0",
          pinnedVersion: "1.2.0",
        },
        {
          machineId: "m1",
          label: "M1",
          ok: true,
          installedVersion: "1.2.0",
          pinnedVersion: "1.2.0",
        },
        {
          machineId: "m3",
          label: "M3",
          ok: false,
          reason: "unauthorized",
          message: "fleet:skills is not granted.",
        },
      ]);
      expect(calls.toSorted((a, b) => a.targets[0]!.localeCompare(b.targets[0]!))).toEqual([
        {
          targets: ["m1"],
          ask: { skill: skillId, version: "1.2.0", pin: true, scope: "user" },
          coordinatorEnvironmentId: "env-coordinator",
        },
        {
          targets: ["m3"],
          ask: {
            skill: skillId,
            version: "1.2.0",
            pin: true,
            scope: "project",
            projectId: "proj-a",
          },
          coordinatorEnvironmentId: "env-coordinator",
        },
        {
          targets: ["m4"],
          ask: {
            skill: skillId,
            version: "1.2.0",
            pin: true,
            scope: "project",
            projectId: "proj-b",
          },
          coordinatorEnvironmentId: "env-coordinator",
        },
      ]);
    }),
  );

  it.effect("refuses unknown or repeated machines, versions nobody lists and a missing fleet", () =>
    Effect.gen(function* () {
      const calls: Array<PushCall> = [];
      const deps = pushDeps({ calls, registry: ["1.2.0"] });
      expect((yield* pushSkillToFleet(deps, push([user("m9")])).pipe(Effect.flip)).reason).toBe(
        "machine_unknown",
      );
      expect(
        (yield* pushSkillToFleet(deps, push([user("m1"), inProject("m1", "p")])).pipe(Effect.flip))
          .reason,
      ).toBe("machine_unknown");
      expect(
        (yield* pushSkillToFleet(deps, push([user("m1")], { version: "9.9.9" })).pipe(Effect.flip))
          .reason,
      ).toBe("version_not_found");
      expect(
        (yield* pushSkillToFleet(pushDeps({ calls, machines: null }), push([user("m1")])).pipe(
          Effect.flip,
        )).reason,
      ).toBe("fleet_unconfigured");
      expect(calls).toEqual([]);

      // A version a project lock here records is pushable even when the registry is unreachable.
      const locked = yield* pushSkillToFleet(
        pushDeps({ calls, registry: undefined, locked: [{ skillId, version: "1.0.5" }] }),
        push([user("m1")], { version: "1.0.5", pin: false }),
      );
      expect(locked.results).toEqual([
        { machineId: "m1", label: "M1", ok: true, installedVersion: "1.0.5", pinnedVersion: null },
      ]);
    }),
  );

  it.effect("reports a machine whose install threw as unreachable", () =>
    Effect.gen(function* () {
      const deps: FleetPushDeps = {
        ...pushDeps({ calls: [], registry: ["1.2.0"] }),
        runInstalls: () => Promise.reject(new Error("socket hang up")),
      };
      const result = yield* pushSkillToFleet(deps, push([user("m1")]));
      expect(result.results).toEqual([
        {
          machineId: "m1",
          ok: false,
          reason: "unreachable",
          message: "No answer from this machine.",
        },
      ]);
    }),
  );

  it("maps outcomes it does not know as failures", () => {
    expect(fleetPushResultOf("m1", { label: "M1" })).toEqual({
      machineId: "m1",
      label: "M1",
      ok: false,
      reason: "install-failed",
      message: "The skill install failed.",
    });
  });
});

describe("Skill Studio link", () => {
  it("reads Studio runtime locks and builds its hash route", () => {
    expect(
      parseStudioLock(
        '{"pid":4242,"port":3077,"cmdline":["node","vskill","studio","--root","/p"]}',
      ),
    ).toEqual({ pid: 4242, port: 3077, cmdline: "node vskill studio --root /p", root: "/p" });
    expect(
      parseStudioLock('{"pid":7,"port":3078,"cmdline":["vskill","studio","--root=/a b"]}')?.root,
    ).toBe("/a b");
    expect(parseStudioLock('{"pid":7,"port":3078,"cmdline":"vskill studio"}')?.root).toBeNull();
    expect(parseStudioLock('{"pid":1,"port":70000}')).toBeNull();
    expect(parseStudioLock('{"pid":-1,"port":3077}')).toBeNull();
    expect(parseStudioLock("garbage")).toBeNull();
    expect(
      studioSkillUrl(3077, { source: "plugin", plugin: "sw", skill: "do it/now" } as never),
    ).toBe("http://localhost:3077/#/skills/plugin/sw/do%20it%2Fnow");
  });

  const linkInput = (source: "project" | "personal" | "plugin") =>
    ({ projectId, source, plugin: "sw", skill: "do" }) as ProjectSkillsStudioLinkInput;

  it.live("reuses a live Studio rooted here, else starts one and waits for its lock", () =>
    Effect.gen(function* () {
      const home = yield* tempDir("project-skills-studio-");
      const runtime = join(home, ".vskill", "runtime");
      const cwd = "/work/project-a";
      yield* write(
        join(runtime, "studio-3001.lock"),
        '{"pid":101,"port":3001,"cmdline":"vskill studio --root /work/other"}',
      );
      yield* write(
        join(runtime, "studio-3002.lock"),
        '{"pid":102,"port":3002,"cmdline":"vskill studio --root /work/project-a"}',
      );
      // Roots that only contain the cwd as a substring belong to other projects.
      yield* write(
        join(runtime, "studio-3000.lock"),
        '{"pid":100,"port":3000,"cmdline":"vskill studio --root /work/project-a-old"}',
      );
      yield* write(
        join(runtime, "studio-2999.lock"),
        '{"pid":99,"port":2999,"cmdline":"vskill studio --root /work/project-a/sub"}',
      );
      const alive = new Set([101, 102]);
      const started: Array<string> = [];
      const studio = yield* makeStudioLink({
        home,
        resolveCwd: () => Effect.succeed(cwd),
        isAlive: (pid) => alive.has(pid),
        startStudio: (root) =>
          Effect.gen(function* () {
            started.push(root);
            yield* write(
              join(runtime, "studio-3003.lock"),
              `{"pid":103,"port":3003,"cmdline":"vskill studio --root ${root}"}`,
            );
            alive.add(103);
            return true;
          }),
        waitMs: 200,
        pollMs: 10,
      });
      expect(yield* studio.link(linkInput("project"))).toEqual({
        url: "http://localhost:3002/#/skills/project/sw/do",
        started: false,
      });

      // The rooted one exited: a personal skill takes any live Studio, a project one starts its own.
      alive.delete(102);
      expect(yield* studio.link(linkInput("personal"))).toEqual({
        url: "http://localhost:3001/#/skills/personal/sw/do",
        started: false,
      });
      alive.add(100);
      alive.add(99);
      expect(yield* studio.link(linkInput("project"))).toEqual({
        url: "http://localhost:3003/#/skills/project/sw/do",
        started: true,
      });
      expect(started).toEqual([cwd]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses with studio_unavailable when Studio will not start or never reports", () =>
    Effect.gen(function* () {
      const home = yield* tempDir("project-skills-studio-");
      const base = {
        home,
        resolveCwd: () => Effect.succeed("/work/project-a"),
        isAlive: () => false,
        waitMs: 30,
        pollMs: 10,
      };
      const missing = yield* makeStudioLink({ ...base, startStudio: () => Effect.succeed(false) });
      expect((yield* missing.link(linkInput("project")).pipe(Effect.flip)).reason).toBe(
        "studio_unavailable",
      );
      const silent = yield* makeStudioLink({ ...base, startStudio: () => Effect.succeed(true) });
      const late = yield* silent.link(linkInput("project")).pipe(Effect.flip);
      expect(late.reason).toBe("studio_unavailable");
      expect(late.detail).toContain("did not report its port");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
