import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";

/**
 * The machine basics first-run setup checks on each machine: Git, which agents
 * use to track and undo their changes, Node.js, which SpecWeave runs on, the
 * GitHub CLI, for publishing, and the SpecWeave CLI itself. The machine's own server answers and, where
 * it can do so without an admin password, installs the missing ones: Node.js
 * and gh from pinned, SHA-256 checked downloads into the app's own folder, and
 * Git through Apple's developer tools or winget. Nothing installed elsewhere
 * is replaced.
 */
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const MachineToolId = Schema.Literals(["git", "node", "gh"]);
export type MachineToolId = typeof MachineToolId.Type;

/** `unknown`: the check gave no answer, for instance it timed out. */
export const MachineToolPresence = Schema.Literals(["present", "missing", "unknown"]);
export type MachineToolPresence = typeof MachineToolPresence.Type;

/** The package manager a copyable Git command is written for. */
export const MachinePackageManager = Schema.Literals(["winget", "apt", "dnf", "pacman", "zypper"]);
export type MachinePackageManager = typeof MachinePackageManager.Type;

/**
 * Every tool machine readiness covers. SpecWeave was added after
 * `MachineToolId`, so it never appears in `installable`, which an older
 * client decodes with the narrower list.
 */
export const MachineReadinessToolId = Schema.Literals(["git", "node", "gh", "specweave"]);
export type MachineReadinessToolId = typeof MachineReadinessToolId.Type;

/** One tool's state on a machine. */
export const MachineToolStatus = Schema.Struct({
  tool: MachineReadinessToolId,
  presence: MachineToolPresence,
  /** The version that runs, or the app's older copy when only that is there. */
  version: Schema.NullOr(bounded(64)),
  /** The copy found is one the app installed into its own folder. */
  managed: Schema.Boolean,
  /** Older than SpecWithCode needs, or than the app's current pin for its own copy. */
  outdated: Schema.Boolean,
  /** The app can install it, or replace its own older copy, with no admin password. */
  canInstall: Schema.Boolean,
});
export type MachineToolStatus = typeof MachineToolStatus.Type;

/** What the last check after an app update did on this machine. */
export const MachineReadinessSweep = Schema.Struct({
  /** The app version the sweep ran for. */
  version: bounded(64),
  at: bounded(64),
  /** `waiting`: work was running, so it waits for a quiet moment. */
  state: Schema.Literals(["waiting", "done", "failed"]),
  installed: Schema.Array(MachineReadinessToolId),
  detail: Schema.NullOr(bounded(2000)),
});
export type MachineReadinessSweep = typeof MachineReadinessSweep.Type;

export const MachineToolsCheck = Schema.Struct({
  git: MachineToolPresence,
  node: MachineToolPresence,
  gh: MachineToolPresence,
  packageManager: Schema.NullOr(MachinePackageManager),
  /** The missing tools this machine's server can install itself, with no admin password. */
  installable: Schema.Array(MachineToolId),
  /** Every tool with its version; absent from a server older than machine readiness. */
  tools: Schema.optionalKey(Schema.Array(MachineToolStatus)),
  /** The check after the last app update; absent before the first one. */
  lastSweep: Schema.optionalKey(MachineReadinessSweep),
});
export type MachineToolsCheck = typeof MachineToolsCheck.Type;

export const MachineToolsCheckInput = Schema.Struct({});
export type MachineToolsCheckInput = typeof MachineToolsCheckInput.Type;

/** An older server refuses `specweave`; a client offers it only when `tools` lists it. */
export const MachineToolInstallInput = Schema.Struct({ tool: MachineReadinessToolId });
export type MachineToolInstallInput = typeof MachineToolInstallInput.Type;

/**
 * An install's progress. `done` with `ok` means installed and checked, or, for
 * Git on a Mac, that macOS opened its own install window (`handedOff`).
 */
export const MachineToolInstallEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("log"), line: bounded(4000) }),
  Schema.Struct({
    type: Schema.Literal("done"),
    ok: Schema.Boolean,
    /** macOS or another installer took over in its own window; check again later. */
    handedOff: Schema.optionalKey(Schema.Boolean),
    detail: Schema.NullOr(bounded(2000)),
  }),
]);
export type MachineToolInstallEvent = typeof MachineToolInstallEvent.Type;

export class MachineToolsError extends Schema.TaggedError<MachineToolsError>()(
  "MachineToolsError",
  {
    /** `present`: the tool is already on the machine and is left as it is. */
    code: Schema.Literals(["unsupported", "busy", "present", "failed"]),
    reason: bounded(2000),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const MACHINE_TOOLS_RPC_METHODS = {
  machineToolsCheck: "machineTools.check",
  machineToolsInstall: "machineTools.install",
} as const;

const error = Schema.Union([MachineToolsError, EnvironmentAuthorizationError]);
export const machineToolsRpcs = [
  Rpc.make(MACHINE_TOOLS_RPC_METHODS.machineToolsCheck, {
    payload: MachineToolsCheckInput,
    success: MachineToolsCheck,
    error,
  }),
  Rpc.make(MACHINE_TOOLS_RPC_METHODS.machineToolsInstall, {
    payload: MachineToolInstallInput,
    success: MachineToolInstallEvent,
    error,
    stream: true,
  }),
] as const;
