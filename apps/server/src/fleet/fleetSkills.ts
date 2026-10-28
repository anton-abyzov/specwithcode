/**
 * Fleet skill installs over SpecWithCode Connect (increment 1125).
 *
 * The fleet primary asks one of its machines to install one published skill
 * at one exact version with vskill, using the management token it already
 * holds there, over whichever address answers (as `fleet update` does).
 *
 * The path is narrow on purpose. The payload names a skill as
 * `owner/repo/name`, an exact `X.Y.Z` version, user or project scope (a
 * project by its id on this machine, never a path) and whether to keep the
 * pin `install @version` sets. This machine runs only a fixed argv, without
 * a shell:
 *
 *   vskill install <owner/repo/name>@<X.Y.Z> -y [--global]
 *
 * with the vskill binary it finds itself, then reads the version back from
 * the lock vskill wrote. A dropped pin is removed from that same lock file
 * here, not with `vskill unpin`: unpin finds its lock by walking up to the
 * nearest `.specweave/config.json`, which can be another project's lock. The answer comes before the install runs, since a
 * Connect response is cut off after about 100 s; the primary reads how it
 * went with the status call.
 */
import {
  AuthEnvironmentMaintainScope,
  AuthFleetSkillsScope,
  type AuthEnvironmentScope,
  ProjectId,
  StudioFleetSkillError,
} from "@specweave-studio/contracts";
import type {
  StudioFleetSkillInput,
  StudioFleetSkillPhase,
  StudioFleetSkillRefusal,
  StudioFleetSkillResult,
  StudioFleetSkillScope,
  StudioFleetSkillStatus,
} from "@specweave-studio/contracts/studioFleet";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Config from "effect/Config";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";
import { checkIdentity, FleetError, type FleetTarget, readBoundedJson } from "../studioFleet.ts";
import { type FleetLink, fleetRequest, reachFleetMachine } from "./fleetTransport.ts";

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

/** `owner/repo/name`, each segment starting with a letter or digit (StudioFleetSkillName). */
const SKILL_NAME =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** An exact `X.Y.Z` (StudioFleetUpdateVersion). */
const SKILL_VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/;

export const isFleetSkillName = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 200 && SKILL_NAME.test(value);

export const isFleetSkillVersion = (value: unknown): value is string =>
  typeof value === "string" && SKILL_VERSION.test(value);

/**
 * Whether a session may use the fleet skills path: the fleet primary's own
 * management token (a coordinator principal for `coordinatorEnvironmentId`)
 * holding `fleet:skills`, or `environment:maintain` for tokens issued before
 * that scope existed.
 */
export function fleetSkillsAllowed(
  session: {
    readonly principal?: { readonly kind: string; readonly environmentId?: string } | undefined;
    readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  },
  coordinatorEnvironmentId: string,
): boolean {
  return (
    session.principal?.kind === "coordinator" &&
    session.principal.environmentId === coordinatorEnvironmentId &&
    (session.scopes.has(AuthFleetSkillsScope) || session.scopes.has(AuthEnvironmentMaintainScope))
  );
}

/** What the skill request asks, without the caller's identity. */
export type FleetSkillAsk = {
  readonly skill: string;
  readonly version: string;
  readonly pin: boolean;
} & ({ readonly scope: "user" } | { readonly scope: "project"; readonly projectId: string });

export const fleetSkillAskOf = (input: StudioFleetSkillInput): FleetSkillAsk =>
  input.scope === "project"
    ? {
        skill: input.skill,
        version: input.version,
        pin: input.pin,
        scope: "project",
        projectId: input.projectId,
      }
    : { skill: input.skill, version: input.version, pin: input.pin, scope: "user" };

/** The name vskill keys the skill by in its lock: the last segment of `owner/repo/name`. */
export const skillLockName = (skill: string): string => skill.split("/").at(-1) ?? skill;

/** The one install argv: `vskill install <skill>@<version> -y`, `--global` for the user. */
export const fleetSkillInstallArgs = (ask: FleetSkillAsk): ReadonlyArray<string> => [
  "install",
  `${ask.skill}@${ask.version}`,
  "-y",
  ...(ask.scope === "user" ? ["--global"] : []),
];

/**
 * Where to look for `vskill`, in order: PATH, then the usual user installs
 * (`~/.local/bin`, Homebrew, `/usr/local/bin`), then npm's global bin. The
 * service's PATH can be narrower than a login shell's.
 */
export function vskillSearchDirs(input: {
  readonly home: string;
  readonly pathEnv: string | undefined;
  readonly npmGlobalBin?: string | null | undefined;
}): ReadonlyArray<string> {
  const fromPath = (input.pathEnv ?? "").split(":").filter((dir) => dir.startsWith("/"));
  const dirs = [
    ...fromPath,
    `${input.home}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(input.npmGlobalBin ? [input.npmGlobalBin] : []),
  ];
  return [...new Set(dirs)];
}

// ---------------------------------------------------------------------------
// This machine: the worker side
// ---------------------------------------------------------------------------

/** One vskill run's result; a spawn failure is `exitCode: null`. */
export interface FleetSkillRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** A lock entry as read back after the install. */
export interface FleetSkillLockEntry {
  readonly version: string;
  readonly pinnedVersion: string | null;
}

export interface FleetSkillWorkerDeps {
  /** The vskill binary's absolute path, or null when none is installed. */
  readonly resolveVskill: Effect.Effect<string | null>;
  /** This user's home folder. */
  readonly home: string;
  /** A project's own workspace root here, or null for an unknown project. */
  readonly projectRoot: (projectId: string) => Effect.Effect<string | null>;
  /** Runs `command args` in `cwd` with no shell. */
  readonly run: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly timeout: Duration.Duration;
  }) => Effect.Effect<FleetSkillRun>;
  /** The entry `name` has in `<dir>/vskill.lock`, or null. */
  readonly readLock: (dir: string, name: string) => Effect.Effect<FleetSkillLockEntry | null>;
  /** Drops the pin of `name` in `<dir>/vskill.lock` itself; false when it could not. */
  readonly dropPin: (dir: string, name: string) => Effect.Effect<boolean>;
}

export class FleetSkillWorker extends Context.Service<
  FleetSkillWorker,
  {
    readonly request: (
      ask: FleetSkillAsk,
    ) => Effect.Effect<StudioFleetSkillResult, StudioFleetSkillError>;
    readonly status: Effect.Effect<StudioFleetSkillStatus>;
  }
>()("specweave-studio/fleet/fleetSkills/FleetSkillWorker") {}

const INSTALL_TIMEOUT = Duration.minutes(5);

const refuse = (reason: StudioFleetSkillRefusal, message: string) =>
  new StudioFleetSkillError({ reason, message });

/** The last words of a failed run, without colour codes, for the status line. */
export function runFailureText(run: FleetSkillRun, what: string): string {
  if (run.timedOut) return `${what} did not finish in time.`;
  if (run.exitCode === null) return `${what} could not be started.`;
  // oxlint-disable-next-line no-control-regex -- strips terminal colour codes.
  const plain = `${run.stderr}\n${run.stdout}`.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const tail = plain.length > 400 ? `…${plain.slice(-400)}` : plain;
  return `${what} exited with ${run.exitCode}${tail === "" ? "." : `: ${tail}`}`;
}

interface Prepared {
  readonly vskill: string;
  readonly installCwd: string;
  readonly lockDirs: ReadonlyArray<string>;
}

export const makeFleetSkillWorker = (deps: FleetSkillWorkerDeps) =>
  Effect.gen(function* () {
    const state = yield* Ref.make<StudioFleetSkillStatus>({ phase: "idle" });
    const set = (next: StudioFleetSkillStatus) => Ref.set(state, next);
    /** One install at a time: claimed before the first await and held until it ends. */
    const claimed = yield* Ref.make(false);
    const counter = yield* Ref.make(0);

    const prepare = (ask: FleetSkillAsk) =>
      Effect.gen(function* () {
        if (!isFleetSkillName(ask.skill) || !isFleetSkillVersion(ask.version))
          return yield* refuse(
            "invalid-skill",
            "Name the skill as owner/repo/name and its version as X.Y.Z.",
          );
        let root: string;
        if (ask.scope === "project") {
          const found = yield* deps.projectRoot(ask.projectId);
          if (found === null)
            return yield* refuse(
              "unknown-project",
              `This machine has no project ${ask.projectId}; name one of its own projects.`,
            );
          root = found;
        } else {
          root = deps.home;
        }
        const vskill = yield* deps.resolveVskill;
        if (vskill === null)
          return yield* refuse(
            "vskill-missing",
            "vskill is not installed on this machine (looked on PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin and npm's global bin). Install it with npm i -g vskill there.",
          );
        const userLock = `${deps.home}/.agents`;
        return {
          vskill,
          installCwd: root,
          // The current user lock, then the legacy one vskill still reads.
          lockDirs: ask.scope === "user" ? [userLock, deps.home] : [root],
        } satisfies Prepared;
      });

    const readBack = (prepared: Prepared, name: string) =>
      Effect.gen(function* () {
        for (const dir of prepared.lockDirs) {
          const entry = yield* deps.readLock(dir, name);
          if (entry !== null) return { dir, entry };
        }
        return null;
      });

    const work = (ask: FleetSkillAsk, prepared: Prepared, base: StudioFleetSkillStatus) =>
      Effect.gen(function* () {
        const failed = (message: string, extra: Partial<StudioFleetSkillStatus> = {}) =>
          set({
            ...base,
            ...extra,
            phase: "failed",
            lastError: message,
            lastErrorReason: "install-failed",
          });
        const install = yield* deps.run({
          command: prepared.vskill,
          args: fleetSkillInstallArgs(ask),
          cwd: prepared.installCwd,
          timeout: INSTALL_TIMEOUT,
        });
        if (install.timedOut || install.exitCode !== 0)
          return yield* failed(runFailureText(install, "vskill install"));
        const name = skillLockName(ask.skill);
        const found = yield* readBack(prepared, name);
        if (found === null)
          return yield* failed(`vskill finished, but its lock has no entry for ${name}.`);
        let entry = found.entry;
        // The pin is dropped in the very lock the install wrote, never by a walk-up.
        if (!ask.pin && entry.pinnedVersion !== null) {
          yield* set({ ...base, phase: "unpinning" });
          if (!(yield* deps.dropPin(found.dir, name)))
            return yield* failed(
              `vskill installed ${entry.version}, but its pin could not be dropped.`,
              {
                installedVersion: entry.version,
                pinnedVersion: entry.pinnedVersion,
              },
            );
          const after = yield* deps.readLock(found.dir, name);
          if (after === null)
            return yield* failed(`The lock lost its entry for ${name} while its pin was dropped.`);
          entry = after;
        }
        const readFields = { installedVersion: entry.version, pinnedVersion: entry.pinnedVersion };
        if (entry.version !== ask.version)
          return yield* failed(
            `vskill finished, but its lock records ${entry.version}, not ${ask.version}.`,
            readFields,
          );
        if (!ask.pin && entry.pinnedVersion !== null)
          return yield* failed(
            `vskill installed ${entry.version}, but its lock still pins ${entry.pinnedVersion}.`,
            readFields,
          );
        yield* set({ ...base, ...readFields, phase: "installed" });
      }).pipe(
        Effect.catchCause(() =>
          set({
            ...base,
            phase: "failed",
            lastError: "The skill install stopped unexpectedly.",
            lastErrorReason: "install-failed",
          }),
        ),
      );

    // Uninterruptible from the claim to the fork, so a request cut off in between
    // (a client that hangs up) cannot leave the claim taken with no install running.
    const request = (ask: FleetSkillAsk) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const acquired = yield* Ref.modify(claimed, (taken) => [!taken, true] as const);
          if (!acquired)
            return yield* refuse(
              "busy",
              "Another skill install is running here; read its progress with the status call.",
            );
          const release = Ref.set(claimed, false);
          const prepared = yield* restore(prepare(ask)).pipe(Effect.onError(() => release));
          const sequence = yield* Ref.updateAndGet(counter, (value) => value + 1);
          const requestId = `${DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))}#${sequence}`;
          const base: StudioFleetSkillStatus = {
            phase: "installing",
            requestId,
            skill: ask.skill,
            version: ask.version,
            scope: ask.scope,
            ...(ask.scope === "project" ? { projectId: ask.projectId } : {}),
            pin: ask.pin,
          };
          yield* set(base);
          yield* restore(work(ask, prepared, base)).pipe(
            Effect.ensuring(release),
            Effect.forkDetach,
          );
          return {
            result: "accepted" as const,
            requestId,
            phase: "installing" as StudioFleetSkillPhase,
            skill: ask.skill,
            version: ask.version,
            scope: ask.scope as StudioFleetSkillScope,
          };
        }),
      );

    return FleetSkillWorker.of({ request, status: Ref.get(state) });
  });

const SkillLockFile = Schema.fromJsonString(
  Schema.Struct({ skills: Schema.Record(Schema.String, Schema.Unknown) }),
);
const SkillLockEntrySchema = Schema.Struct({
  version: Schema.String,
  pinnedVersion: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const decodeSkillLockFile = Schema.decodeUnknownOption(SkillLockFile);
const decodeSkillLockEntry = Schema.decodeUnknownOption(SkillLockEntrySchema);
const decodeProjectId = Schema.decodeUnknownOption(ProjectId);

/** One lock entry from the text of a `vskill.lock`, or null when it has none. */
export function lockEntryOf(text: string, name: string): FleetSkillLockEntry | null {
  const lock = decodeSkillLockFile(text);
  if (Option.isNone(lock) || !Object.hasOwn(lock.value.skills, name)) return null;
  const entry = decodeSkillLockEntry(lock.value.skills[name]);
  if (Option.isNone(entry)) return null;
  return { version: entry.value.version, pinnedVersion: entry.value.pinnedVersion ?? null };
}

/**
 * The text of a `vskill.lock` with `name`'s pin removed, as `vskill unpin`
 * writes it (every other field kept, `updatedAt` refreshed), or null when the
 * lock or its entry is not there.
 */
export function lockWithoutPin(text: string, name: string, now: string): string | null {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return null;
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(lock) || !isRecord(lock.skills) || !Object.hasOwn(lock.skills, name)) return null;
  const entry = lock.skills[name];
  if (!isRecord(entry)) return null;
  delete entry.pinnedVersion;
  lock.updatedAt = now;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const NPM_TIMEOUT = Duration.seconds(15);

/** The live worker: this machine's vskill, project registry and lock files. */
export const layer = Layer.effect(
  FleetSkillWorker,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = expandHomePath("~");
    const pathEnv = Option.getOrUndefined(yield* Config.String("PATH").pipe(Config.option));

    const executable = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => info.type === "File" && (Number(info.mode) & 0o111) !== 0),
        Effect.orElseSucceed(() => false),
      );
    const findIn = (dirs: ReadonlyArray<string>, name: string) =>
      Effect.gen(function* () {
        for (const dir of dirs) {
          const candidate = path.join(dir, name);
          if (yield* executable(candidate)) return candidate;
        }
        return null;
      });
    /** `npm prefix -g`/bin, asked of the npm found the same way, only when needed. */
    const npmGlobalBin = Effect.gen(function* () {
      const npm = yield* findIn(vskillSearchDirs({ home, pathEnv }), "npm");
      if (npm === null) return null;
      const output = yield* runner
        .run({
          command: npm,
          args: ["prefix", "-g"],
          timeout: NPM_TIMEOUT,
          maxOutputBytes: 16 * 1024,
          outputMode: "truncate",
          env: { PATH: [path.dirname(npm), pathEnv ?? ""].join(":") },
        })
        .pipe(Effect.option);
      if (Option.isNone(output) || output.value.timedOut || output.value.code !== 0) return null;
      const prefix = output.value.stdout.trim();
      return prefix.startsWith("/") ? path.join(prefix, "bin") : null;
    });
    // Resolved on each request: vskill can be installed or moved while this runs.
    const resolveVskill = Effect.gen(function* () {
      const found = yield* findIn(vskillSearchDirs({ home, pathEnv }), "vskill");
      if (found !== null) return found;
      const npmBin = yield* npmGlobalBin;
      return npmBin === null ? null : yield* findIn([npmBin], "vskill");
    });

    const projectRoot = (projectId: string) =>
      Effect.gen(function* () {
        const id = decodeProjectId(projectId);
        if (Option.isNone(id)) return null;
        const project = yield* projects.get(id.value).pipe(Effect.orElseSucceed(Option.none));
        if (Option.isNone(project)) return null;
        const root = project.value.workspaceRoot;
        const info = yield* fs.stat(root).pipe(Effect.option);
        return Option.isSome(info) && info.value.type === "Directory" ? root : null;
      });

    const run: FleetSkillWorkerDeps["run"] = ({ command, args, cwd, timeout }) =>
      runner
        .run({
          command,
          args,
          cwd,
          timeout,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: 256 * 1024,
          outputMode: "truncate",
          // vskill is a node script: its own folder first, so its `node` is found.
          env: {
            PATH: [path.dirname(command), `${home}/.local/bin`, "/opt/homebrew/bin", pathEnv ?? ""]
              .filter((entry) => entry !== "")
              .join(":"),
            NO_COLOR: "1",
          },
        })
        .pipe(
          Effect.map((output): FleetSkillRun => ({
            exitCode: output.code === null ? null : Number(output.code),
            stdout: output.stdout,
            stderr: output.stderr,
            timedOut: output.timedOut,
          })),
          Effect.orElseSucceed((): FleetSkillRun => ({
            exitCode: null,
            stdout: "",
            stderr: "",
            timedOut: false,
          })),
        );

    const readLock = (dir: string, name: string) =>
      Effect.gen(function* () {
        const file = path.join(dir, "vskill.lock");
        const info = yield* fs.stat(file).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") return null;
        if (Number(info.value.size) > MAX_LOCK_BYTES) return null;
        const text = yield* fs.readFileString(file).pipe(Effect.option);
        return Option.isNone(text) ? null : lockEntryOf(text.value, name);
      });

    const dropPin = (dir: string, name: string) =>
      Effect.gen(function* () {
        // The file a symlinked lock points at, as vskill's own write would follow it.
        const file = yield* fs.realPath(path.join(dir, "vskill.lock"));
        const info = yield* fs.stat(file);
        if (info.type !== "File" || Number(info.size) > MAX_LOCK_BYTES) return false;
        const millis = yield* Clock.currentTimeMillis;
        const next = lockWithoutPin(
          yield* fs.readFileString(file),
          name,
          DateTime.formatIso(DateTime.makeUnsafe(millis)),
        );
        if (next === null) return false;
        // Written beside the lock and renamed over it, so a reader never sees half a lock.
        // One install runs at a time, so the name is free; `wx` refuses it otherwise.
        const temporary = `${file}.fleet-skills-${millis}.tmp`;
        yield* fs
          .writeFileString(temporary, next, { flag: "wx", mode: Number(info.mode) & 0o777 })
          .pipe(
            Effect.andThen(fs.rename(temporary, file)),
            Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
          );
        return true;
      }).pipe(Effect.orElseSucceed(() => false));

    return yield* makeFleetSkillWorker({
      resolveVskill,
      home,
      projectRoot,
      run,
      readLock,
      dropPin,
    });
  }),
);

// ---------------------------------------------------------------------------
// The fleet primary: the client side
// ---------------------------------------------------------------------------

export type FleetSkillFailureReason =
  | "unreachable"
  | "connect-unbound"
  | "connect-key-missing"
  | "identity-mismatch"
  | "unauthorized"
  | StudioFleetSkillRefusal;

/** Why the primary could not get a skill installed; `reason` is stable for scripts. */
export class FleetSkillFailure extends Error {
  readonly reason: FleetSkillFailureReason;
  constructor(reason: FleetSkillFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** One machine's JSON line for `fleet skills --json`. */
export type FleetSkillOutcome = Record<string, unknown>;

export interface FleetSkillClientInput {
  readonly link: FleetLink;
  readonly target: FleetTarget;
  readonly coordinatorEnvironmentId: string;
  readonly ask: FleetSkillAsk;
  /** How long the install may take before the primary stops waiting. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const transportOf = (origin: { readonly transport: string }) =>
  origin.transport === "connect" ? "connect" : "tailnet";

const failureOf = (error: unknown): FleetSkillFailure => {
  if (error instanceof FleetSkillFailure) return error;
  if (error instanceof FleetError) {
    const reason =
      error.kind === "connect-unbound" ||
      error.kind === "connect-key-missing" ||
      error.kind === "identity-mismatch"
        ? error.kind
        : error.kind === "pairing-unavailable" || error.kind === "forbidden"
          ? "unauthorized"
          : "unreachable";
    return new FleetSkillFailure(reason, error.message);
  }
  return new FleetSkillFailure(
    "unreachable",
    "This machine is unavailable over Connect or Tailscale.",
  );
};

async function answerOf(response: Response): Promise<unknown> {
  return readBoundedJson(response).catch(() => null);
}

const REFUSALS: ReadonlySet<string> = new Set<StudioFleetSkillRefusal>([
  "unsupported",
  "vskill-missing",
  "invalid-skill",
  "unknown-project",
  "install-failed",
  "busy",
]);

async function refusalOf(response: Response): Promise<FleetSkillFailure> {
  const body = await answerOf(response);
  const message =
    record(body) && typeof body.message === "string"
      ? body.message
      : `The machine answered HTTP ${response.status}.`;
  if (response.status === 401 || response.status === 403)
    return new FleetSkillFailure(
      "unauthorized",
      `The management token saved for this machine is not allowed to install skills there (${message}). On that machine choose Invite this machine again and add the new line here.`,
    );
  if (response.status === 400)
    return new FleetSkillFailure("invalid-skill", `The machine refused the request: ${message}`);
  if (
    record(body) &&
    body._tag === "StudioFleetSkillError" &&
    typeof body.reason === "string" &&
    REFUSALS.has(body.reason)
  )
    return new FleetSkillFailure(body.reason as StudioFleetSkillRefusal, message);
  return new FleetSkillFailure("install-failed", message);
}

const defaultSleep = (ms: number) => Effect.runPromise(Effect.sleep(Duration.millis(ms)));
const defaultNow = () => Effect.runSync(Clock.currentTimeMillis);

/**
 * Asks `target` from the primary to install the skill version, then waits for
 * the install to finish and returns the version that machine's lock records.
 */
export async function runFleetSkillInstall(
  input: FleetSkillClientInput,
): Promise<FleetSkillOutcome> {
  const { link, target, ask, coordinatorEnvironmentId } = input;
  if (!isFleetSkillName(ask.skill) || !isFleetSkillVersion(ask.version))
    throw new FleetSkillFailure(
      "invalid-skill",
      "Name the skill as owner/repo/name and its version as X.Y.Z.",
    );
  const token = target.managementToken;
  if (token === undefined)
    throw new FleetSkillFailure(
      "unauthorized",
      `No management token is saved for ${target.label}. On that machine choose Invite this machine and add the line here.`,
    );
  let descriptor;
  try {
    const reached = await reachFleetMachine(link, target, { token });
    descriptor = await checkIdentity(link.fetch, {
      url: reached.origin,
      environmentId: target.environmentId,
    });
  } catch (error) {
    throw failureOf(error);
  }
  if ((descriptor.capabilities as Record<string, unknown>).fleetSkillUpdate !== true)
    throw new FleetSkillFailure(
      "unsupported",
      `${target.label} runs ${descriptor.serverVersion}, which cannot take skill installs from here; update it first.`,
    );

  const payload = {
    coordinatorEnvironmentId,
    skill: ask.skill,
    version: ask.version,
    scope: ask.scope,
    ...(ask.scope === "project" ? { projectId: ask.projectId } : {}),
    pin: ask.pin,
  };
  let response: Response;
  let address;
  try {
    ({ response, address } = await fleetRequest(link, target, "/api/studio/fleet/skills", {
      method: "POST",
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 75_000,
    }));
  } catch (error) {
    throw failureOf(error);
  }
  if (!response.ok) throw await refusalOf(response);
  const accepted = await answerOf(response);
  if (!record(accepted) || accepted.result !== "accepted" || typeof accepted.requestId !== "string")
    throw new FleetSkillFailure(
      "install-failed",
      "The machine gave no answer to the skill install.",
    );
  const requestId = accepted.requestId;
  const common = {
    machine: target.id,
    label: target.label,
    transport: transportOf(address),
    skill: ask.skill,
    version: ask.version,
    scope: ask.scope,
    ...(ask.scope === "project" ? { projectId: ask.projectId } : {}),
    pin: ask.pin,
    requestId,
  };

  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? defaultNow;
  const deadline = now() + (input.waitMs ?? 420_000);
  for (;;) {
    await sleep(input.pollMs ?? 3_000);
    let statusResponse: Response;
    try {
      ({ response: statusResponse } = await fleetRequest(
        link,
        target,
        `/api/studio/fleet/skills?coordinatorEnvironmentId=${encodeURIComponent(coordinatorEnvironmentId)}`,
        { method: "GET", token, idempotent: true, timeoutMs: 75_000 },
      ));
    } catch (error) {
      throw failureOf(error);
    }
    if (!statusResponse.ok) throw await refusalOf(statusResponse);
    const status = await answerOf(statusResponse);
    if (!record(status) || typeof status.phase !== "string")
      throw new FleetSkillFailure("install-failed", "The machine gave no skill install status.");
    if (status.requestId !== requestId)
      throw new FleetSkillFailure(
        "busy",
        `${target.label} moved on to another skill install before this one could be read.`,
      );
    if (status.phase === "installed")
      return {
        ...common,
        result: "installed",
        installedVersion: status.installedVersion ?? null,
        pinnedVersion: status.pinnedVersion ?? null,
      };
    if (status.phase === "failed") {
      const reason =
        typeof status.lastErrorReason === "string" && REFUSALS.has(status.lastErrorReason)
          ? (status.lastErrorReason as StudioFleetSkillRefusal)
          : "install-failed";
      throw new FleetSkillFailure(
        reason,
        typeof status.lastError === "string" ? status.lastError : "The skill install failed.",
      );
    }
    if (now() >= deadline)
      throw new FleetSkillFailure(
        "busy",
        `${target.label} is still ${status.phase} ${ask.skill}@${ask.version}; ask again later.`,
      );
  }
}

/**
 * `fleet skills` against several machines, four at a time: one outcome per
 * machine in the order asked, either the version read back from its lock or
 * `{error, reason}`. One machine failing never stops the others.
 */
export async function runFleetSkillInstalls(
  input: Omit<FleetSkillClientInput, "target"> & { readonly targets: ReadonlyArray<FleetTarget> },
): Promise<ReadonlyArray<FleetSkillOutcome>> {
  const { targets, ...rest } = input;
  const outcomes: FleetSkillOutcome[] = Array.from({ length: targets.length });
  let next = 0;
  const lane = async () => {
    for (let index = next++; index < targets.length; index = next++) {
      const target = targets[index]!;
      outcomes[index] = await runFleetSkillInstall({ ...rest, target }).catch(
        (error: unknown): FleetSkillOutcome => {
          const failure =
            error instanceof FleetSkillFailure
              ? error
              : new FleetSkillFailure("unreachable", "The machine could not be reached.");
          return {
            machine: target.id,
            label: target.label,
            skill: rest.ask.skill,
            version: rest.ask.version,
            scope: rest.ask.scope,
            error: failure.message,
            reason: failure.reason,
          };
        },
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, lane));
  return outcomes;
}
