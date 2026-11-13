import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";

/**
 * The machine basics first-run setup checks on each machine: Git, which agents
 * use to track and undo their changes, Node.js, which SpecWeave runs on, and
 * the GitHub CLI, for publishing. The machine's own server answers and, where
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

export const MachineToolsCheck = Schema.Struct({
  git: MachineToolPresence,
  node: MachineToolPresence,
  gh: MachineToolPresence,
  packageManager: Schema.NullOr(MachinePackageManager),
  /** The missing tools this machine's server can install itself, with no admin password. */
  installable: Schema.Array(MachineToolId),
});
export type MachineToolsCheck = typeof MachineToolsCheck.Type;

export const MachineToolsCheckInput = Schema.Struct({});
export type MachineToolsCheckInput = typeof MachineToolsCheckInput.Type;

export const MachineToolInstallInput = Schema.Struct({ tool: MachineToolId });
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
