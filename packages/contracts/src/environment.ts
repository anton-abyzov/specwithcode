import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleOptional,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Wire version for orchestration snapshots, streams, commands, and RPC payloads. */
export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_VERSION_TEXT = "2";
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const ORCHESTRATION_PROTOCOL_HEADER = "x-studio-orchestration-protocol";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

/**
 * The curated set of machine shapes and OS identities an environment can wear as its icon.
 * Servers detect one from the hardware they run on (`platform.machine`), and
 * the `environmentIcon` server setting lets a user pick one instead.
 */
export const ENVIRONMENT_MACHINE_KINDS = [
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
] as const;
export const EnvironmentMachineKind = Schema.Literals(ENVIRONMENT_MACHINE_KINDS);
export type EnvironmentMachineKind = typeof EnvironmentMachineKind.Type;
export const isEnvironmentMachineKind = Schema.is(EnvironmentMachineKind);

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  /** Hardware shape detected at startup. Absent when the host gives no usable
      signal (containers, Windows, unknown DMI), on servers that predate it, or
      when a newer server names a kind this build cannot draw. */
  machine: ForwardCompatibleOptional(EnvironmentMachineKind),
});

/**
 * Where a new thread runs: the project's current checkout ("local") or a
 * fresh git worktree ("worktree"). Lives here (not settings.ts) so
 * orchestration contracts can reference it without an import cycle.
 */
export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

/**
 * How a new worktree populates git submodules: every nested level, only the
 * ones this repository declares, or not at all.
 */
export const WorktreeSubmodules = Schema.Literals(["recursive", "top-level", "none"]);
export type WorktreeSubmodules = typeof WorktreeSubmodules.Type;
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

/** How a server can replace itself with another version when asked over RPC.
    New servers only advertise the stable launcher-backed "boot-service" path;
    "respawn" remains decodable for compatibility with older servers.
    "desktop-app" means the supervising desktop app updated and relaunched
    itself, bringing the server back with it. */
export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn", "desktop-app"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

/** Proven ownership for a manual update; unknown installs omit this descriptor. */
export const ServerInstallation = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["npx", "pnpm-dlx", "bunx"]) }),
  Schema.Struct({ kind: Schema.Literal("npm-global"), prefix: TrimmedNonEmptyString }),
]);
export type ServerInstallation = typeof ServerInstallation.Type;

/** What update path a client should offer for a server: one of the RPC
    self-update methods above, or "desktop-managed" when the backend's
    version belongs to the SpecWithCode desktop app supervising it — updating the
    app on that machine is the only way to update the server. */
export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  /** Missing on older servers, which still accept inline image attachments. */
  attachmentUploads: Schema.optionalKey(Schema.Boolean),
  /** Uploaded files may accompany question answers. */
  questionAttachments: Schema.optionalKey(Schema.Boolean),
  /** Missing on servers that only accept image attachments. */
  fileAttachments: Schema.optionalKey(
    Schema.Struct({
      maxUploadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
  /** Server exposes the pull-request list, detail, activity, diff, and mutation APIs. Absent on
      servers from before the pull-request workspace shipped, so clients must not probe them. */
  pullRequests: Schema.optionalKey(Schema.Boolean),
  pullRequestChecks: Schema.optionalKey(Schema.Boolean),
  /** Server understands canonical inline context links plus their message context records.
      Absent on servers from before inline context shipped, which drop the records and forward
      the links as literal text -- so a client must serialize context the legacy way for them. */
  inlineMessageContext: Schema.optionalKey(Schema.Boolean),
  /** Server rejects required worktrees instead of falling back to the project checkout. */
  requiredWorktreeBootstrap: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.settle / thread.unsettle commands. Absent on
      pre-settlement servers, so clients treat missing as unsupported and
      never send the commands under version skew. */
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  /** Server evaluates merge and inactivity settlement without a client. */
  threadAutoSettlement: Schema.optionalKey(Schema.Boolean),
  storageCleanup: Schema.optionalKey(Schema.Boolean),
  projectWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  /** Server honors the `worktreesDirectory` setting. */
  worktreesDirectory: Schema.optionalKey(Schema.Boolean),
  worktreeLocationMode: Schema.optionalKey(Schema.Boolean),
  /** Server persists the opt-in for continuing interrupted threads after restarts. */
  threadRestartContinuation: Schema.optionalKey(Schema.Boolean),
  /** Server resolves `projectSettingsOverrides`; older servers ignore the key. */
  projectSettingsOverrides: Schema.optionalKey(Schema.Boolean),
  /** Server applies `projectSettingsOverrideChanges` key by key; older servers
      drop that key, so clients replace the whole entry there instead. */
  projectSettingsOverrideChanges: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.snooze / thread.unsnooze commands. Same
      version-skew contract as threadSettlement. */
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** Server streams themes an environment publishes. Absent on servers from
      before environment themes shipped, which never emit the events -- so a
      client reconnecting to one must drop published themes rather than keep
      showing a set nothing will ever update. */
  environmentThemes: Schema.optionalKey(Schema.Boolean),
  /** Server streams quota from configured usage-limit sources. Same
      version-skew contract as environmentThemes. */
  usageLimitSources: Schema.optionalKey(Schema.Boolean),
  /** Server persists custom model rates and applies them to usage summaries. */
  usagePriceOverrides: Schema.optionalKey(Schema.Boolean),
  /** Server persists model mappings and folds mapped usage into the target model. */
  usageModelAliases: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.pin / thread.unpin commands. Same
      version-skew contract as threadSettlement. */
  threadPinning: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.pin.reorder (and orderKey on thread.pin).
      Same version-skew contract as threadSettlement. */
  threadPinReorder: Schema.optionalKey(Schema.Boolean),
  /** Server persists manual Active order through thread.active.reorder. */
  threadActiveReorder: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.auto-settle.set (per-thread auto-settle off).
      Same version-skew contract as threadSettlement. */
  threadAutoSettleOptOut: Schema.optionalKey(Schema.Boolean),
  /** Server understands regenerateTitle on thread.meta.update. Absent on
      older servers, so clients hide the action instead of sending it. */
  threadTitleRegeneration: Schema.optionalKey(Schema.Boolean),
  /** Accepts `thread.move-to-project`; older servers omit it. */
  threadProjectMove: Schema.optionalKey(Schema.Boolean),
  /** Accepts `design.move` and answers moved designs with `movedTo`; older servers omit it. */
  designMove: Schema.optionalKey(Schema.Boolean),
  /** Accepts `design.importDeck` (PowerPoint import into slides); older servers omit it. */
  designDeckImport: Schema.optionalKey(Schema.Boolean),
  /** Accepts `design.previewDeck` (a host .pptx read as slides for the file viewer); older servers omit it. */
  designDeckPreview: Schema.optionalKey(Schema.Boolean),
  /** Accepts `designSystem.create`, `apply` and the `designSystem.file*` methods; older servers omit it. */
  designSystemEditing: Schema.optionalKey(Schema.Boolean),
  /** Threads add_comment replies by parentId; older servers omit it and clients hide Reply. */
  designCommentReplies: Schema.optionalKey(Schema.Boolean),
  /** Accepts format `svg` on `design.export`; older servers omit it. */
  designSvgExport: Schema.optionalKey(Schema.Boolean),
  /** Server removes a private machine from its list (`removeFleetMachine`).
      Absent on servers from before 1.0.58, which answer 404: clients keep the
      rest of the private machines list working and say only removal needs an update. */
  studioFleetRemove: Schema.optionalKey(Schema.Boolean),
  /** Server takes its fleet primary's update requests at `/api/studio/fleet/update`.
      Absent on older servers: the primary falls back to the boot service's
      self-update RPC on Linux, or reports that the machine updates itself. */
  fleetUpdateRequest: Schema.optionalKey(Schema.Boolean),
  /** Server takes its fleet primary's skill installs at `/api/studio/fleet/skills`.
      Absent on older servers: the primary reports `unsupported` for them. */
  fleetSkillUpdate: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.visit / thread.mark-unread commands and
      projects lastVisitedAt on thread shells. Same version-skew contract as
      threadSettlement: clients keep their local visited state against
      servers that lack this. */
  threadVisitedTracking: Schema.optionalKey(Schema.Boolean),
  /** Server persists a pull request reference on thread.meta.update. */
  threadPullRequestLinking: Schema.optionalKey(Schema.Boolean),
  /** Server resolves message delivery and model-selection context and validates
      identified rollback readiness. Clients retain projection-based command
      shaping and validation when this is absent. */
  serverResolvedCommandContext: Schema.optionalKey(Schema.Boolean),
  threadPullRequests: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.pull-request.watch and wakes agents on pull request changes. */
  threadPullRequestWatch: Schema.optionalKey(Schema.Boolean),
  pullRequestStackActions: Schema.optionalKey(Schema.Boolean),
  /** The update path clients should offer for this server. Absent on
      servers that must be relaunched manually (dev checkouts, Windows
      foreground runs, pre-update servers). */
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  /** Manual commands must update this install, not the host's default global prefix. */
  serverInstallation: ForwardCompatibleOptional(ServerInstallation),
  /** Server can stream self-update progress before acknowledging the
      restart. Clients fall back to server.updateServer when absent. */
  serverSelfUpdateProgress: Schema.optionalKey(Schema.Boolean),
  /** Server answers provision.preview and provision.run (Settings > Connections > Provision). */
  machineProvision: Schema.optionalKey(Schema.Boolean),
  /** Server answers gitHubSignIn.* (sign its gh in from another device). Absent on older
      servers, where clients keep the `gh auth login` hint instead. */
  gitHubSignIn: Schema.optionalKey(Schema.Boolean),
  /** Server answers gitHubCredential.* (shows its GitHub access, copies its sign-in to a fleet
      machine, stores and removes one copied in). Older servers hide the copy option. */
  gitHubCredentialCopy: Schema.optionalKey(Schema.Boolean),
  /** Server can durably mark running provider turns before a self-update and
      continue them after the replacement process starts. */
  serverUpdateThreadContinuation: Schema.optionalKey(Schema.Boolean),
  /** Agent-activity publishes (push notifications and Live Activities)
      currently leave this environment: the publish opt-in is enabled and the
      relay link credentials exist. Clients skip seeding a Live Activity when
      this is false — no update would ever repaint it. Absent on older
      servers, which may still publish, so only an explicit false skips. */
  agentActivityPublishing: Schema.optionalKey(Schema.Boolean),
  /** Server runs repository clones for new projects in the background and
      streams their progress (`projectClone.*`, `subscribeProjectClones`).
      Absent on older servers, where clients must clone with the blocking
      `sourceControl.cloneRepository` call instead. */
  projectCloneTracking: Schema.optionalKey(Schema.Boolean),
  /** Server answers `sourceControl.checkRemoteAccess` (a `git ls-remote` with
      its own credentials) and `sourceControl.inspectDestination`. Absent on
      older servers; clients then don't offer Add to another machine there. */
  cloneDestinationChecks: Schema.optionalKey(Schema.Boolean),
  /** Server keeps the `machineNicknames` setting and swaps it with paired
      machines. Older servers drop the key, so clients write renames only to
      servers that report this. */
  machineNicknames: Schema.optionalKey(Schema.Boolean),
  /** Server detects `platform.machine` and persists the `environmentIcon`
      setting. Older servers drop the key on write, so clients show the
      picker inert rather than offering a choice that would never stick. */
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  /** The desktop app supervising this server can be driven over RPC:
      server.updateServer runs its check -> download -> relaunch. Absent on
      desktop servers whose app predates the remote trigger, where clients
      must keep telling the user to update the app on that machine. */
  desktopAppUpdate: Schema.optionalKey(Schema.Boolean),
  /** Server hosts preview tabs in its own headless Chromium (`runtime:
      "server"`) and streams them over `/api/preview-stream`. Clients
      without a local browser runtime open server tabs here. */
  serverBrowser: Schema.optionalKey(Schema.Boolean),
  /** The desktop app that started this server renders its browser tabs and
      the server drives them over the desktop browser channel. Absent on a
      server the desktop only attached to (an installed service), whose tabs
      run in the server's own browser and stream to every client. */
  desktopBrowserChannel: Schema.optionalKey(Schema.Boolean),
  /** Server honours `agentBrowserProfileId`, letting agent tabs share a
      persistent browser profile instead of throwaway storage. */
  agentBrowserProfile: Schema.optionalKey(Schema.Boolean),
  /** Server resolves `agentBrowserProfileId` per project, from the thread's
      project overrides. Absent on servers that apply only the environment value. */
  projectAgentBrowserProfile: Schema.optionalKey(Schema.Boolean),
  /** Server lists, approves and serves Studio Mods (`mods.list` and friends).
      Absent on servers from before Mods shipped, which reject those calls, so
      clients say the service predates Mods instead of probing it. */
  studioMods: Schema.optionalKey(Schema.Boolean),
  /** Server answers `mods.specweave`, the summary behind the `specweave:read`
      mod permission. Absent on older servers. */
  studioModsSpecweave: Schema.optionalKey(Schema.Boolean),
  /** Server runs the Telegram channel (`telegramChannel.*`). Absent on older
      servers, where clients say the service predates it. */
  telegramChannel: Schema.optionalKey(Schema.Boolean),
  /** Server connects a Google account for read-only Gmail, Calendar and Drive
      (`googleAccount.*`). Absent on older servers. */
  googleAccount: Schema.optionalKey(Schema.Boolean),
  /** Server links a project with its copy on another machine (`projectLink.*`,
      `projects.fingerprint`). Absent on older servers, which reject those calls,
      so clients ask to update that machine first. */
  projectLink: Schema.optionalKey(Schema.Boolean),
  /** Serves coordinator takeover, giving way and coordinator note replicas
      (`projectLink.takeover`, `supersede`, `replicate`, `digest`). */
  coordinatorTakeover: Schema.optionalKey(Schema.Boolean),
  /** Runs a coordinator on every member machine of a linked project
      (`projectLink.startCoordinator`). Absent on older servers, where a
      member can only take over the single coordinator. */
  coordinatorPerMachine: Schema.optionalKey(Schema.Boolean),
  /** Replicates a linked project's native plan so claims bind on every machine
      (`projectLink.planExport`, `projectLink.planMerge`). */
  linkedPlans: Schema.optionalKey(Schema.Boolean),
  /** Server indexes project knowledge (`projects.knowledge*`). Absent on older
      servers, where clients say the knowledge card needs an update. */
  projectKnowledge: Schema.optionalKey(Schema.Boolean),
  /** Replicates project memory both ways between linked members
      (`projectLink.memoryExport`, `memoryMerge`). Absent on older servers. */
  linkedMemorySync: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  /** Git commit the installed service release was bundled from. Absent on
      dev checkouts and older servers. Clients compare it with the commit of
      a local desktop build, whose version string differs by design. */
  serverSourceCommit: Schema.optionalKey(TrimmedNonEmptyString),
  /** Absent on hosts from before explicit orchestration protocol negotiation. */
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  /** Authoritative managed worktree root on this machine; absent on older servers. */
  defaultWorktreesDirectory: Schema.optionalKey(TrimmedNonEmptyString),
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

/**
 * The checkout's own remote when it names a different repository than the canonical one, such as
 * a fork that tracks its upstream. Clients group and label by it so a fork stays distinct from the
 * repository it forked, while pull request features keep the canonical identity.
 */
export const RepositoryOrigin = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryOrigin = typeof RepositoryOrigin.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  /** Repository browser URL resolved from the server's configured hosting account. */
  webUrl: Schema.optionalKey(TrimmedNonEmptyString),
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  origin: Schema.optionalKey(RepositoryOrigin),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

/** Key clients group checkouts by: a fork's own remote, otherwise the canonical repository. */
export function repositoryGroupingKeyOf(identity: RepositoryIdentity): string {
  return identity.origin?.canonicalKey ?? identity.canonicalKey;
}

/** Label clients show for a checkout's repository, matching `repositoryGroupingKeyOf`. */
export function repositoryGroupingDisplayNameOf(identity: RepositoryIdentity): string | undefined {
  return identity.origin
    ? (identity.origin.displayName ?? identity.origin.canonicalKey)
    : identity.displayName;
}

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;
