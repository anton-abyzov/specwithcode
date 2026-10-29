/**
 * ProjectSkillsFleet — "Push to machines" and "Release in Skill Studio".
 *
 * Push installs one skill version on chosen fleet machines through the same
 * path as `specweave-studio fleet skills` (`runFleetSkillInstalls`, over
 * Connect or Tailscale with each machine's management token). The machines
 * must be in this machine's fleet file, the version must be one the registry
 * lists or a project lock here records, and each receiving machine checks
 * `fleet:skills` again. One result comes back per machine, in the order asked.
 *
 * The Studio link reuses a running Skill Studio when its runtime lock names a
 * live process, preferring one rooted at this folder, and otherwise starts
 * `vskill studio --root <folder>` detached and waits for its lock. The link
 * is Studio's own hash route, `#/skills/<source>/<plugin>/<skill>`.
 *
 * @module project/ProjectSkillsFleet
 */
import type {
  ProjectId,
  ProjectSkillsFleetPushInput,
  ProjectSkillsFleetPushResult,
  ProjectSkillsStudioLink,
  ProjectSkillsStudioLinkInput,
} from "@specweave-studio/contracts";
import { ProjectSkillsActionError } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type {
  FleetSkillAsk,
  FleetSkillOutcome,
  runFleetSkillInstalls,
} from "../fleet/fleetSkills.ts";
import type { FleetLink } from "../fleet/fleetTransport.ts";
import type { FleetTarget } from "../studioFleet.ts";
import { actionError } from "./ProjectSkillsActionsCommon.ts";

export interface FleetPushDeps {
  /** The fleet file's machines and the link that reaches them; null without a fleet file. */
  readonly loadFleet: (
    projectId: ProjectId,
  ) => Effect.Effect<
    { readonly machines: ReadonlyArray<FleetTarget>; readonly link: FleetLink } | null,
    ProjectSkillsActionError
  >;
  readonly coordinatorEnvironmentId: Effect.Effect<string>;
  readonly runInstalls: typeof runFleetSkillInstalls;
  /** Versions the registry lists for the skill; undefined when they could not be read. */
  readonly registryVersions: (skillId: string) => Effect.Effect<ReadonlyArray<string> | undefined>;
  /** `owner/repo/name@version` pairs the project's locks here record. */
  readonly lockedVersions: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<{ readonly skillId: string; readonly version: string }>>;
}

const outcomeRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOr = (value: unknown) => (typeof value === "string" ? value : undefined);
const versionOr = (value: unknown) =>
  typeof value === "string" ? value : value === null ? null : undefined;

/** One machine's result from a fleet install outcome. */
export function fleetPushResultOf(machineId: string, outcome: FleetSkillOutcome | undefined) {
  if (!outcomeRecord(outcome))
    return { machineId, ok: false, reason: "unreachable", message: "No answer from this machine." };
  const label = stringOr(outcome.label);
  if (outcome.result === "installed")
    return {
      machineId,
      ...(label ? { label } : {}),
      ok: true,
      installedVersion: versionOr(outcome.installedVersion) ?? null,
      pinnedVersion: versionOr(outcome.pinnedVersion) ?? null,
    };
  return {
    machineId,
    ...(label ? { label } : {}),
    ok: false,
    reason: stringOr(outcome.reason) ?? "install-failed",
    message: stringOr(outcome.error) ?? "The skill install failed.",
  };
}

export const pushSkillToFleet = Effect.fn("projectSkills.pushSkillToFleet")(function* (
  deps: FleetPushDeps,
  input: ProjectSkillsFleetPushInput,
) {
  const fleet = yield* deps.loadFleet(input.projectId);
  if (fleet === null || fleet.machines.length === 0)
    return yield* actionError(input.projectId, "fleet_unconfigured");
  const seen = new Set<string>();
  const chosen: Array<{
    readonly target: (typeof input.targets)[number];
    readonly machine: FleetTarget;
  }> = [];
  for (const target of input.targets) {
    const machine = fleet.machines.find((candidate) => candidate.id === target.machineId);
    if (machine === undefined)
      return yield* actionError(
        input.projectId,
        "machine_unknown",
        `${target.machineId} is not in this machine's fleet.`,
      );
    if (seen.has(target.machineId))
      return yield* actionError(
        input.projectId,
        "machine_unknown",
        `${target.machineId} is listed twice.`,
      );
    seen.add(target.machineId);
    chosen.push({ target, machine });
  }
  const locked = yield* deps.lockedVersions(input.projectId);
  const known =
    locked.some((entry) => entry.skillId === input.skillId && entry.version === input.version) ||
    ((yield* deps.registryVersions(input.skillId)) ?? []).includes(input.version);
  if (!known)
    return yield* actionError(
      input.projectId,
      "version_not_found",
      `Neither the registry nor this project's locks list ${input.skillId}@${input.version}.`,
    );

  // One ask per scope: the user lock, or one project (named by its id on that machine).
  const groups = new Map<string, { ask: FleetSkillAsk; entries: typeof chosen }>();
  for (const entry of chosen) {
    const key = entry.target.scope === "user" ? "user" : `project:${entry.target.projectId}`;
    const ask: FleetSkillAsk =
      entry.target.scope === "user"
        ? { skill: input.skillId, version: input.version, pin: input.pin, scope: "user" }
        : {
            skill: input.skillId,
            version: input.version,
            pin: input.pin,
            scope: "project",
            projectId: entry.target.projectId,
          };
    const group = groups.get(key) ?? { ask, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  const coordinatorEnvironmentId = yield* deps.coordinatorEnvironmentId;
  const answered = new Map<string, FleetSkillOutcome>();
  yield* Effect.forEach(
    [...groups.values()],
    (group) =>
      Effect.tryPromise(() =>
        deps.runInstalls({
          link: fleet.link,
          targets: group.entries.map((entry) => entry.machine),
          coordinatorEnvironmentId,
          ask: group.ask,
        }),
      ).pipe(
        Effect.map((outcomes) =>
          group.entries.forEach((entry, index) => {
            const outcome = outcomes[index];
            if (outcome !== undefined) answered.set(entry.target.machineId, outcome);
          }),
        ),
        Effect.ignore,
      ),
    { concurrency: 4, discard: true },
  );
  return {
    results: input.targets.map((target) =>
      fleetPushResultOf(target.machineId, answered.get(target.machineId)),
    ),
  } satisfies ProjectSkillsFleetPushResult;
});

// ---------------------------------------------------------------------------
// Skill Studio
// ---------------------------------------------------------------------------

const StudioLock = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Number,
    port: Schema.Number,
    cmdline: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeStudioLock = Schema.decodeUnknownOption(StudioLock);

export interface StudioInstance {
  readonly pid: number;
  readonly port: number;
  readonly cmdline: string;
  /** The `--root` folder Studio was started with, or null when the command line names none. */
  readonly root: string | null;
}

/** The value of `--root <dir>` or `--root=<dir>` in a Studio command line. */
export function studioRootOf(args: ReadonlyArray<string>): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--root") return args[index + 1] || null;
    if (arg.startsWith("--root=")) return arg.slice("--root=".length) || null;
  }
  return null;
}

/** A `studio-<port>.lock` from `~/.vskill/runtime`, or null when it is not one. */
export function parseStudioLock(text: string): StudioInstance | null {
  const lock = decodeStudioLock(text);
  if (Option.isNone(lock)) return null;
  const { pid, port, cmdline } = lock.value;
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535)
    return null;
  // An argv array keeps a root with spaces whole; a joined string is split on whitespace.
  const args =
    typeof cmdline === "string"
      ? cmdline.split(/\s+/).filter(Boolean)
      : Array.isArray(cmdline)
        ? cmdline.filter((part): part is string => typeof part === "string")
        : [];
  return {
    pid,
    port,
    cmdline: typeof cmdline === "string" ? cmdline : args.join(" "),
    root: studioRootOf(args),
  };
}

/** Studio's hash route for one skill. */
export const studioSkillUrl = (
  port: number,
  input: Pick<ProjectSkillsStudioLinkInput, "source" | "plugin" | "skill">,
) =>
  `http://localhost:${port}/#/skills/${input.source}/${encodeURIComponent(input.plugin)}/${encodeURIComponent(input.skill)}`;

export interface StudioLinkDeps {
  readonly home: string;
  /** The project folder the link is for, checked like a Skills read. */
  readonly resolveCwd: (
    input: ProjectSkillsStudioLinkInput,
  ) => Effect.Effect<string, ProjectSkillsActionError>;
  readonly isAlive: (pid: number) => boolean;
  /** Starts `vskill studio --root <cwd>` detached; false when vskill is missing or would not start. */
  readonly startStudio: (cwd: string) => Effect.Effect<boolean>;
  readonly waitMs?: number;
  readonly pollMs?: number;
}

export class ProjectSkillsStudio extends Context.Service<
  ProjectSkillsStudio,
  {
    readonly link: (
      input: ProjectSkillsStudioLinkInput,
    ) => Effect.Effect<ProjectSkillsStudioLink, ProjectSkillsActionError>;
  }
>()("specweave-studio/project/ProjectSkillsFleet/ProjectSkillsStudio") {}

export const makeStudioLink = Effect.fn("projectSkills.makeStudioLink")(function* (
  deps: StudioLinkDeps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = path.join(deps.home, ".vskill", "runtime");

  const running = Effect.gen(function* () {
    const names = yield* fs.readDirectory(runtimeDir).pipe(Effect.orElseSucceed(() => []));
    const instances: Array<StudioInstance> = [];
    for (const name of names.filter((entry) => /^studio-\d+\.lock$/.test(entry)).toSorted()) {
      const text = yield* fs
        .readFileString(path.join(runtimeDir, name))
        .pipe(Effect.orElseSucceed(() => ""));
      const instance = parseStudioLock(text);
      if (instance !== null && deps.isAlive(instance.pid)) instances.push(instance);
    }
    return instances;
  });

  /**
   * A Studio whose `--root` is `cwd` itself first (a root that merely starts
   * with it, such as a sibling or a child folder, is another project); for the
   * user's and plugin skills any live one does.
   */
  const pick = (instances: ReadonlyArray<StudioInstance>, cwd: string, anyRoot: boolean) =>
    instances.find(
      (instance) => instance.root !== null && path.resolve(instance.root) === path.resolve(cwd),
    ) ?? (anyRoot ? instances[0] : undefined);

  const link = (input: ProjectSkillsStudioLinkInput) =>
    Effect.gen(function* () {
      const cwd = yield* deps.resolveCwd(input);
      const anyRoot = input.source !== "project";
      const before = yield* running;
      const existing = pick(before, cwd, anyRoot);
      if (existing !== undefined)
        return { url: studioSkillUrl(existing.port, input), started: false };
      const known = new Set(before.map((instance) => instance.pid));
      if (!(yield* deps.startStudio(cwd)))
        return yield* actionError(
          input.projectId,
          "studio_unavailable",
          "Skill Studio could not be started; is vskill installed?",
        );
      const pollMs = deps.pollMs ?? 250;
      for (let waited = 0; waited <= (deps.waitMs ?? 10_000); waited += pollMs) {
        const now = yield* running;
        // The one this request started, by its root or as the instance that was not there before.
        const started = pick(now, cwd, false) ?? now.find((instance) => !known.has(instance.pid));
        if (started !== undefined)
          return { url: studioSkillUrl(started.port, input), started: true };
        yield* Effect.sleep(pollMs);
      }
      return yield* new ProjectSkillsActionError({
        projectId: input.projectId,
        reason: "studio_unavailable",
        detail: "Skill Studio was started but did not report its port in time; try again.",
      });
    });

  return ProjectSkillsStudio.of({ link });
});
