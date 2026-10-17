import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * Anthropic cloud sessions: Claude Code sessions that run on Anthropic's VMs
 * instead of a machine in the owner's fleet. The app only drives the user's
 * own Claude Code CLI (`claude --cloud`, `claude -p --cloud <id>`,
 * `claude --teleport <id>`); it stores no credential and reads no transcript,
 * because the CLI exposes neither.
 */

/** Whether this server can start cloud sessions with the installed Claude Code CLI. */
export const CloudSessionAvailabilityStatus = Schema.Literals([
  "ready",
  "needs_login",
  "unsupported_auth",
  "cli_missing",
  "cli_too_old",
  "unknown",
]);
export type CloudSessionAvailabilityStatus = typeof CloudSessionAvailabilityStatus.Type;

export const CloudSessionAvailability = Schema.Struct({
  status: CloudSessionAvailabilityStatus,
  cliVersion: Schema.NullOr(Schema.String),
  /** `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, `third_party` or `none`, as `claude auth status` reports. */
  authMethod: Schema.NullOr(Schema.String),
  /** `pro`, `max`, `team`, `enterprise` when the CLI reports one. */
  subscriptionType: Schema.NullOr(Schema.String),
  /** One sentence on why cloud sessions are or are not available here. */
  reason: Schema.String,
  /** What the user can do about it, or null when nothing is needed. */
  fix: Schema.NullOr(Schema.String),
  checkedAt: IsoDateTime,
});
export type CloudSessionAvailability = typeof CloudSessionAvailability.Type;

/** `session_…` or `cse_…`, as claude.ai/code names them. */
export const CloudSessionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{6,128}$/));
export type CloudSessionId = typeof CloudSessionId.Type;

export const CloudSessionRecord = Schema.Struct({
  sessionId: CloudSessionId,
  url: Schema.String,
  title: Schema.String,
  /** The first 2,000 characters of the task the session started with. */
  task: Schema.String,
  repositoryPath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  remoteUrl: Schema.NullOr(Schema.String),
  /** True when the checkout was uploaded as a bundle instead of cloned from GitHub. */
  uploaded: Schema.Boolean,
  projectId: Schema.NullOr(ProjectId),
  createdByThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  lastSentAt: Schema.NullOr(IsoDateTime),
});
export type CloudSessionRecord = typeof CloudSessionRecord.Type;

export const CloudSessionCreateInput = Schema.Struct({
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
    description:
      "The whole task, self-contained: the cloud VM has no access to this conversation, this machine or its files beyond the pushed branch.",
  }),
  projectId: Schema.optional(ProjectId),
  /** A checkout under the project to start from; defaults to the project root. */
  worktreePath: Schema.optional(Schema.String),
  /**
   * Upload the checkout as a bundle (committed files only, under 100 MB)
   * instead of requiring a pushed GitHub branch. The session then cannot
   * push results back.
   */
  upload: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type CloudSessionCreateInput = typeof CloudSessionCreateInput.Type;

export const CloudSessionCreateResult = Schema.Struct({
  session: CloudSessionRecord,
  /** `claude --teleport <id>`: run it in a checkout of the same repository to continue locally. */
  teleportCommand: Schema.String,
});
export type CloudSessionCreateResult = typeof CloudSessionCreateResult.Type;

export const CloudSessionSendInput = Schema.Struct({
  sessionId: CloudSessionId,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
});
export type CloudSessionSendInput = typeof CloudSessionSendInput.Type;

export const CloudSessionSendResult = Schema.Struct({
  ok: Schema.Boolean,
  sessionId: CloudSessionId,
  url: Schema.NullOr(Schema.String),
  /** The CLI's exact error text when `ok` is false. */
  error: Schema.NullOr(Schema.String),
});
export type CloudSessionSendResult = typeof CloudSessionSendResult.Type;

export const CloudSessionsListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type CloudSessionsListInput = typeof CloudSessionsListInput.Type;

/** GET query: `refresh=true` re-runs the CLI sign-in check instead of using the cached one. */
export const CloudSessionsQuery = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  refresh: Schema.optional(Schema.Literals(["true", "false"])),
});
export type CloudSessionsQuery = typeof CloudSessionsQuery.Type;

export const CloudSessionsSnapshot = Schema.Struct({
  availability: CloudSessionAvailability,
  sessions: Schema.Array(CloudSessionRecord),
});
export type CloudSessionsSnapshot = typeof CloudSessionsSnapshot.Type;

export const cloudSessionTeleportCommand = (sessionId: string): string =>
  `claude --teleport ${sessionId}`;

/** The oldest Claude Code that has `--cloud`, `-p --cloud <id>` with JSON output and `/teleport`. */
export const CLOUD_SESSIONS_MIN_CLI_VERSION = "2.1.223";
