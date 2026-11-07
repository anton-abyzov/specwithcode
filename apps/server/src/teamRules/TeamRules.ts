// @effect-diagnostics nodeBuiltinImport:off globalDate:off - reads one root-owned file at a fixed path, from services that have no FileSystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type ProjectId, TEAM_RULES_MAX_BYTES } from "@specweave-studio/contracts";
import {
  canonicalTeamRules,
  parseTeamRulesText,
  TEAM_RULES_NONE,
  teamRulesMachinePath,
  type TeamRulesState,
} from "@specweave-studio/shared/teamRules";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeTeamRulesFolderReader } from "./TeamRulesScope.ts";

/**
 * Where the machine's rules live. Hardcoded on purpose: a path derived from the
 * home directory, `STUDIO_*` or settings is one any shell agent can change.
 */
export function machineTeamRulesPath(platform: NodeJS.Platform = process.platform): string {
  return teamRulesMachinePath(platform);
}

export const teamRulesFingerprint = (canonical: string) =>
  NodeCrypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);

const isMissing = (cause: unknown) => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const describeFailure = (path: string, cause: unknown) =>
  `Could not read ${path}: ${(cause as NodeJS.ErrnoException | undefined)?.code ?? String(cause)}.`;

/** An agent running as the user must not be able to change the rules. */
const protectionWarnings = (path: string): ReadonlyArray<string> => {
  if (process.platform === "win32") return [];
  const warnings: Array<string> = [];
  for (const target of [path, NodePath.dirname(path)]) {
    try {
      const stat = NodeFS.statSync(target);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        warnings.push(
          `${target} can be changed by someone other than root, so an agent could change these rules. Make it root-owned and not group or world writable.`,
        );
      }
    } catch {
      // The read below reports a file it cannot reach.
    }
  }
  return warnings;
};

/** Reads and judges a rules file once. A missing file is no rules; anything else broken holds. */
export function readTeamRulesFile(path: string): TeamRulesState {
  let text: string;
  try {
    const stat = NodeFS.statSync(path);
    if (!stat.isFile()) {
      return { status: "hold", issues: [`${path} is not a regular file.`] };
    }
    if (stat.size > TEAM_RULES_MAX_BYTES) {
      return {
        status: "hold",
        issues: [`${path} is larger than ${TEAM_RULES_MAX_BYTES} bytes.`],
      };
    }
    text = NodeFS.readFileSync(path, "utf8");
  } catch (cause) {
    if (isMissing(cause)) return TEAM_RULES_NONE;
    return { status: "hold", issues: [describeFailure(path, cause)] };
  }
  const parsed = parseTeamRulesText(text);
  if (!parsed.ok) {
    return {
      status: "hold",
      issues: parsed.issues,
      ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
      ...(parsed.contact === undefined ? {} : { contact: parsed.contact }),
    };
  }
  return {
    status: "active",
    rules: parsed.rules,
    fingerprint: teamRulesFingerprint(canonicalTeamRules(parsed.rules)),
    warnings: [...protectionWarnings(path), ...parsed.warnings],
  };
}

/** A write this close to the last read can leave the same size and timestamp. */
const TEAM_RULES_TIMESTAMP_TRUST_MS = 2_000;

/** Re-reads only when the file changed, so a check on every turn costs one stat. */
export function makeTeamRulesReader(path: string): () => TeamRulesState {
  let seen: string | undefined;
  let state: TeamRulesState = TEAM_RULES_NONE;
  let recentlyWritten = false;
  return () => {
    let identity: string;
    let modifiedAt: number | undefined;
    try {
      const stat = NodeFS.statSync(path);
      identity = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.uid}:${stat.mode}`;
      modifiedAt = stat.mtimeMs;
    } catch (cause) {
      identity = isMissing(cause) ? "missing" : `failed:${String(cause)}`;
    }
    // A hold can come from a passing read failure, so it never outlives the fault.
    if (identity !== seen || state.status === "hold" || recentlyWritten) {
      const next = readTeamRulesFile(path);
      if (JSON.stringify(next) !== JSON.stringify(state)) state = next;
      seen = identity;
      recentlyWritten =
        modifiedAt !== undefined && Date.now() - modifiedAt < TEAM_RULES_TIMESTAMP_TRUST_MS;
    }
    return state;
  };
}

export interface TeamRulesShape {
  /** The rules right now. Tightening applies to the next check. */
  readonly current: Effect.Effect<TeamRulesState>;
  /**
   * The rules for one working folder: the machine's, plus its zones and the
   * repository's committed rules. Reach, tools and `same-rules` are about the
   * machine, so they ask `current`.
   */
  readonly forFolder: (cwd: string) => Effect.Effect<TeamRulesState>;
}

const machineReader = makeTeamRulesReader(machineTeamRulesPath());

const folderReader = makeTeamRulesFolderReader(machineReader);

/** The machine's rules, for the few launch helpers that are not Effects. */
export const readMachineTeamRules = (): TeamRulesState => machineReader();

/**
 * The rules in force on this machine. The default is the machine file, so a
 * service that nobody wired up still enforces them; tests provide another.
 */
export class TeamRules extends Context.Reference<TeamRulesShape>("studio/teamRules/TeamRules", {
  defaultValue: () => ({
    current: Effect.sync(machineReader),
    forFolder: (cwd) => Effect.promise(() => folderReader(cwd)),
  }),
}) {}

export const currentTeamRules: Effect.Effect<TeamRulesState> = Effect.gen(function* () {
  const rules = yield* TeamRules;
  return yield* rules.current;
});

/** The rules for a thread's working folder; the machine's when it has none. */
export const teamRulesForFolder = (cwd: string | null | undefined) =>
  cwd === null || cwd === undefined || cwd.length === 0
    ? currentTeamRules
    : Effect.gen(function* () {
        const rules = yield* TeamRules;
        return yield* rules.forFolder(cwd);
      });

/**
 * The rules for a thread: its worktree, else its project's folder. A project
 * that cannot be read gets the machine's rules; the turn fails on it anyway.
 */
export const teamRulesForThread = <E, R>(
  projects: {
    readonly get: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<{ readonly workspaceRoot: string }>, E, R>;
  },
  thread: { readonly projectId: ProjectId; readonly worktreePath?: string | null | undefined },
): Effect.Effect<TeamRulesState, never, R> =>
  thread.worktreePath !== null && thread.worktreePath !== undefined
    ? teamRulesForFolder(thread.worktreePath)
    : projects.get(thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((project) => teamRulesForFolder(project?.workspaceRoot)),
      );

/** A fixed state, for tests; `folders` gives some folders their own. */
export const teamRulesOf = (
  state: TeamRulesState,
  folders: Readonly<Record<string, TeamRulesState>> = {},
): TeamRulesShape => ({
  current: Effect.succeed(state),
  forFolder: (cwd) => Effect.succeed(folders[cwd] ?? state),
});

const POLL_INTERVAL = "5 seconds";

const stateKey = (state: TeamRulesState) =>
  state.status === "active"
    ? `active:${state.fingerprint}`
    : state.status === "hold"
      ? `hold:${state.issues.join("\n")}`
      : "none";

/** Runs `handler` after each change to the rules. Never returns; fork it. */
export const watchTeamRules = <E, R>(
  handler: (state: TeamRulesState) => Effect.Effect<void, E, R>,
): Effect.Effect<never, E, R> =>
  Effect.gen(function* () {
    let last = stateKey(yield* currentTeamRules);
    while (true) {
      yield* Effect.sleep(POLL_INTERVAL);
      const state = yield* currentTeamRules;
      const key = stateKey(state);
      if (key === last) continue;
      last = key;
      yield* handler(state);
    }
  });
