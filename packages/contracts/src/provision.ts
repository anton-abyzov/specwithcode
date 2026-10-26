import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";

/**
 * Provisioning a fleet machine: the pinned packages a worker needs (git, gh,
 * Node.js 22, Claude Code, Codex) plus the SpecWithCode server and its
 * service, installed or verified on the machine itself. Tailscale is optional:
 * checked when present, installed only when SpecWithCode Connect does not
 * already reach the machine (otherwise its item is `skipped`). The readback is
 * what `specwithcode provision --json` prints and what Settings > Connections
 * shows; it never carries a credential, only whether a sign-in exists.
 */
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const PROVISION_READBACK_SCHEMA_VERSION = 1;

export const ProvisionItemId = Schema.Literals([
  "git",
  "gh",
  "node",
  "claude",
  "codex",
  "tailscale",
  "server",
  "service",
  "service-path",
  "linger",
  "legacy-names",
]);
export type ProvisionItemId = typeof ProvisionItemId.Type;

/**
 * - `ok`: already there at the wanted version (or newer, see `kept-newer`); nothing changed.
 * - `changed`: installed or upgraded by this run, then verified.
 * - `planned`: a dry run would change it.
 * - `needs-root`: waits for the one root command in `rootStep`.
 * - `user-action`: only the user can do it; `command` says how.
 * - `skipped`: not needed here, or left out on request; `detail` says why.
 */
export const ProvisionItemStatus = Schema.Literals([
  "pending",
  "running",
  "ok",
  "kept-newer",
  "changed",
  "planned",
  "needs-root",
  "user-action",
  "failed",
  "skipped",
]);
export type ProvisionItemStatus = typeof ProvisionItemStatus.Type;

export const ProvisionItem = Schema.Struct({
  id: ProvisionItemId,
  label: bounded(200),
  /** The pinned version, or a minimum such as ">= 2.34" for packages from a signed repository. */
  wanted: bounded(200),
  found: Schema.NullOr(bounded(200)),
  status: ProvisionItemStatus,
  /** Where it comes from and how it is checked, e.g. "github.com/cli/cli release, SHA-256 pinned". */
  source: bounded(500),
  detail: Schema.NullOr(bounded(2000)),
  /** The exact command for a `needs-root`, `user-action` or `failed` item. */
  command: Schema.NullOr(bounded(2000)),
});
export type ProvisionItem = typeof ProvisionItem.Type;

export const ProvisionTarget = Schema.Struct({
  platform: bounded(40),
  arch: bounded(40),
  /** os-release ID and VERSION_ID on Linux, "macos" and the product version on macOS. */
  osId: bounded(80),
  osVersion: bounded(80),
  prettyName: bounded(200),
  libc: Schema.Literals(["glibc", "musl", "darwin", "unknown"]),
  init: Schema.Literals(["systemd", "launchd", "none"]),
  supported: Schema.Boolean,
  reason: Schema.NullOr(bounded(1000)),
  nearest: Schema.NullOr(bounded(500)),
});
export type ProvisionTarget = typeof ProvisionTarget.Type;

export const ProvisionService = Schema.Struct({
  manager: Schema.Literals(["systemd", "launchd", "none"]),
  unit: Schema.NullOr(bounded(500)),
  installed: Schema.Boolean,
  active: Schema.Boolean,
  /** Set when the service manager could not be asked at all; `active` is then unknown, not false. */
  managerError: Schema.optional(bounded(500)),
  version: Schema.NullOr(bounded(80)),
  home: Schema.NullOr(bounded(4096)),
  /** Agent commands the service cannot find on the PATH its server reads at start. */
  missingOnPath: Schema.Array(bounded(80)),
});
export type ProvisionService = typeof ProvisionService.Type;

export const ProvisionProvider = Schema.Struct({
  id: Schema.Literals(["claude", "codex", "gh"]),
  found: Schema.Boolean,
  version: Schema.NullOr(bounded(80)),
  path: Schema.NullOr(bounded(4096)),
  /** Whether a sign-in exists; never its contents. Null when the command is missing. */
  signedIn: Schema.NullOr(Schema.Boolean),
});
export type ProvisionProvider = typeof ProvisionProvider.Type;

export const ProvisionUserStep = Schema.Struct({
  id: bounded(80),
  title: bounded(500),
  command: Schema.NullOr(bounded(2000)),
  optional: Schema.Boolean,
});
export type ProvisionUserStep = typeof ProvisionUserStep.Type;

export const ProvisionRootStep = Schema.Struct({
  /** One line to run in the machine's own terminal, e.g. `sudo sh '/home/me/.specwithcode/provision/root-steps.sh'`. */
  command: bounded(2000),
  script: bounded(4096),
  sha256: bounded(64),
  items: Schema.Array(ProvisionItemId),
  /** Whether this run already ran it (passwordless sudo or a password typed at the terminal). */
  ran: Schema.Boolean,
});
export type ProvisionRootStep = typeof ProvisionRootStep.Type;

export const ProvisionReadback = Schema.Struct({
  schemaVersion: Schema.Literal(PROVISION_READBACK_SCHEMA_VERSION),
  /** The release whose pinned manifest this run used. */
  manifestVersion: bounded(80),
  runId: bounded(80),
  generatedAt: bounded(40),
  dryRun: Schema.Boolean,
  resumed: Schema.Boolean,
  target: ProvisionTarget,
  items: Schema.Array(ProvisionItem),
  service: ProvisionService,
  server: Schema.Struct({ wanted: bounded(80), found: Schema.NullOr(bounded(80)) }),
  providers: Schema.Array(ProvisionProvider),
  rootStep: Schema.NullOr(ProvisionRootStep),
  userSteps: Schema.Array(ProvisionUserStep),
  /** True when this run installed, upgraded or rewrote anything. */
  changed: Schema.Boolean,
  /** True when nothing failed and nothing waits for root; user steps may remain. */
  ok: Schema.Boolean,
  summary: bounded(2000),
  logPath: Schema.NullOr(bounded(4096)),
});
export type ProvisionReadback = typeof ProvisionReadback.Type;

export const ProvisionEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("plan"), readback: ProvisionReadback }),
  Schema.Struct({ type: Schema.Literal("item"), item: ProvisionItem }),
  Schema.Struct({ type: Schema.Literal("log"), id: ProvisionItemId, line: bounded(2000) }),
  Schema.Struct({ type: Schema.Literal("done"), readback: ProvisionReadback }),
]);
export type ProvisionEvent = typeof ProvisionEvent.Type;

export const ProvisionPreviewInput = Schema.Struct({});
export type ProvisionPreviewInput = typeof ProvisionPreviewInput.Type;

export const ProvisionRunInput = Schema.Struct({
  /** Continue the last unfinished run: its finished steps are only re-checked. Retry uses this. */
  resume: Schema.optional(Schema.Boolean),
});
export type ProvisionRunInput = typeof ProvisionRunInput.Type;

export class ProvisionError extends Schema.TaggedError<ProvisionError>()("ProvisionError", {
  code: Schema.Literals(["unsupported", "busy", "no-run-to-resume", "failed"]),
  reason: bounded(2000),
}) {
  override get message(): string {
    return this.reason;
  }
}

export const PROVISION_RPC_METHODS = {
  provisionPreview: "provision.preview",
  provisionRun: "provision.run",
} as const;

const error = Schema.Union([ProvisionError, EnvironmentAuthorizationError]);
export const provisionRpcs = [
  Rpc.make(PROVISION_RPC_METHODS.provisionPreview, {
    payload: ProvisionPreviewInput,
    success: ProvisionReadback,
    error,
  }),
  Rpc.make(PROVISION_RPC_METHODS.provisionRun, {
    payload: ProvisionRunInput,
    success: ProvisionEvent,
    error,
    stream: true,
  }),
] as const;
