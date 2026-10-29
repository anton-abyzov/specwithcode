/**
 * ProjectSkillsToggles — turning one skill, or the plugin it ships in, on or
 * off for one agent, the way that agent itself does it:
 *
 * | Agent  | Skill                                   | Plugin                                              | Takes effect   |
 * |--------|-----------------------------------------|-----------------------------------------------------|----------------|
 * | Claude | `skillOverrides` edit (ClaudeSettingsWrite) | `claude plugin enable|disable -s <scope> --json -- <id>` | next session |
 * | Codex  | app server `skills/config/write`        | app server `config/value/write plugins."<id>".enabled` | now          |
 * | Grok   | refused: its ignore list hides the skill for good | `grok plugin enable|disable -- <name>` (user only) | `/plugins reload` |
 *
 * Codex writes go through its own app server, never a TOML edit; when it
 * cannot be started the switch is refused with `agent_unavailable`. A write
 * that lands but that a higher config layer overrides (Codex layers, or a
 * Claude project file enabling a plugin) is reported as applied, with the
 * state the agent really ends up in and a warning, so the change can still
 * be undone. A Claude skill switch that its requested file cannot decide is
 * moved to the repository's local settings file by the plan, and the
 * preview says so.
 * The agent named by the request must be the one the row lists under that
 * instance, so a Claude skill switch (which needs only file access) cannot
 * be pointed at another agent's CLI.
 *
 * @module project/ProjectSkillsToggles
 */
import type {
  ProjectSkillPresence,
  ProjectSkillsActionInput,
  ProjectSkillsActionResult,
  ProjectSkillsLiveness,
} from "@specweave-studio/contracts";
import { ProjectSkillsActionError } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { ProviderSkillsControl } from "../provider/ProviderDriver.ts";
import { sha256 } from "../nodeCrypto.ts";
import {
  applyClaudeSkillOverride,
  type ClaudeSettingsWriteError,
  planClaudeSkillOverride,
  readClaudePluginEnabled,
} from "./ClaudeSettingsWrite.ts";
import {
  actionError,
  cliFailure,
  type CodexConfigClient,
  type ProjectSkillsActionsDeps,
  type RunCli,
  type SkillsActionContext,
} from "./ProjectSkillsActionsCommon.ts";

type ToggleSkill = Extract<ProjectSkillsActionInput["action"], { readonly kind: "toggle-skill" }>;
type TogglePlugin = Extract<ProjectSkillsActionInput["action"], { readonly kind: "toggle-plugin" }>;
export type Serialized = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

const CLI_TIMEOUT = "60 seconds";

/** `claude plugin enable|disable -s <scope> --json -- <plugin@marketplace>`. */
export const claudePluginArgs = (
  pluginId: string,
  enabled: boolean,
  scope: "user" | "project" | "local",
) => ["plugin", enabled ? "enable" : "disable", "-s", scope, "--json", "--", pluginId];

/** `grok plugin enable|disable -- <name>`; Grok has no scope flag. */
export const grokPluginArgs = (name: string, enabled: boolean) => [
  "plugin",
  enabled ? "enable" : "disable",
  "--",
  name,
];

/** Codex's config key for a plugin's switch. */
export const codexPluginKeyPath = (pluginId: string) => `plugins."${pluginId}".enabled`;

const LIVENESS: Readonly<Record<string, ProjectSkillsLiveness>> = {
  claudeAgent: "next-session",
  codex: "now",
  grok: "reload",
};

export const makeSkillsToggles = (deps: ProjectSkillsActionsDeps, run: RunCli) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const presenceOf = (ctx: SkillsActionContext, action: ToggleSkill | TogglePlugin) =>
      Effect.gen(function* () {
        const presence = ctx.row.providers.find(
          (candidate) => candidate.instanceId === action.instanceId,
        );
        if (presence === undefined)
          return yield* actionError(
            ctx.projectId,
            "skill_not_found",
            `${action.instanceId} does not load ${ctx.row.name} in this folder.`,
          );
        if (presence.driver !== action.provider)
          return yield* actionError(
            ctx.projectId,
            "skill_not_found",
            `${action.instanceId} is a ${presence.driver} agent, not ${action.provider}.`,
          );
        return presence;
      });

    const controlOf = (ctx: SkillsActionContext, presence: ProjectSkillPresence) =>
      Effect.gen(function* () {
        const control = yield* deps.agentControl(presence.instanceId);
        if (control === undefined)
          return yield* actionError(
            ctx.projectId,
            "agent_unavailable",
            `${presence.label} is not running in SpecWithCode on this machine.`,
          );
        return control;
      });

    const fileHash = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map((text) => sha256([text], "hex")),
        Effect.orElseSucceed(() => "absent"),
      );

    const settingsError =
      (ctx: SkillsActionContext) =>
      (error: ClaudeSettingsWriteError): ProjectSkillsActionError =>
        new ProjectSkillsActionError({
          projectId: ctx.projectId,
          reason: error.reason === "write_failed" ? "cli_failed" : error.reason,
          detail: error.detail,
        });

    /** True when git ignores `file`, false when it does not, undefined outside a repository. */
    const gitIgnored = (root: string, file: string) =>
      run({
        command: "git",
        args: ["check-ignore", "-q", "--", file],
        cwd: root,
        timeout: "10 seconds",
        env: { PATH: deps.environment.PATH ?? "" },
      }).pipe(
        Effect.map((result) =>
          result.exitCode === 0 ? true : result.exitCode === 1 ? false : undefined,
        ),
      );

    const refreshed = (ctx: SkillsActionContext, presence: ProjectSkillPresence) =>
      deps.afterWrite({
        projectId: ctx.projectId,
        cwd: ctx.cwd,
        instanceIds: [presence.instanceId],
      });

    const codexRequestFailed = (ctx: SkillsActionContext, what: string) => (cause: unknown) =>
      new ProjectSkillsActionError({
        projectId: ctx.projectId,
        reason: "agent_unavailable",
        detail: `Codex could not ${what}.`,
        cause,
      });

    /** Asks Codex to read its skills again from disk; a failure here leaves the write in place. */
    const codexReload = (client: CodexConfigClient, cwd: string) =>
      client.request("skills/list", { cwds: [cwd], forceReload: true }).pipe(Effect.ignore);

    // -----------------------------------------------------------------------
    // One skill
    // -----------------------------------------------------------------------

    const claudeSkill = (
      ctx: SkillsActionContext,
      input: ProjectSkillsActionInput,
      action: ToggleSkill,
      presence: ProjectSkillPresence,
      serialized: Serialized,
    ) =>
      Effect.gen(function* () {
        const control = yield* controlOf(ctx, presence);
        const configDir = control.homePath ?? path.join(deps.home, ".claude");
        const plan = planClaudeSkillOverride({
          configDir,
          cwd: ctx.cwd,
          key: presence.name ?? ctx.row.name,
          enabled: action.enabled,
          scope: action.scope,
          platform: deps.platform,
          environment: control.environment,
          managedPath: deps.managedSettingsPath,
        }).pipe(Effect.mapError(settingsError(ctx)));
        const warningsOf = (planned: Effect.Success<typeof plan>) =>
          Effect.gen(function* () {
            if (!planned.localFile || planned.repositoryRoot === undefined || !planned.changed)
              return planned.warnings;
            const ignored = yield* gitIgnored(planned.repositoryRoot, planned.target);
            return ignored === false
              ? [
                  ...planned.warnings,
                  `${planned.target} is not gitignored, so this switch could be committed.`,
                ]
              : planned.warnings;
          });
        if (input.preview) {
          const planned = yield* plan;
          return {
            preview: {
              files: [planned.target],
              summary: planned.summary,
              liveness: "next-session",
              warnings: yield* warningsOf(planned),
              expected: { fileHash: planned.currentHash },
            },
          } satisfies ProjectSkillsActionResult;
        }
        return yield* serialized(
          ctx.cwd,
          Effect.gen(function* () {
            const planned = yield* plan;
            yield* applyClaudeSkillOverride(planned, {
              expectedHash: input.expected?.fileHash,
              backupDir: deps.backupDir,
            }).pipe(Effect.mapError(settingsError(ctx)));
            yield* refreshed(ctx, presence);
            return {
              applied: true,
              summary: planned.summary,
              liveness: "next-session",
              effectiveEnabled: planned.effectiveEnabled,
              warnings: yield* warningsOf(planned),
            } satisfies ProjectSkillsActionResult;
          }),
        );
      });

    const codexSkill = (
      ctx: SkillsActionContext,
      input: ProjectSkillsActionInput,
      action: ToggleSkill,
      presence: ProjectSkillPresence,
      serialized: Serialized,
    ) =>
      Effect.gen(function* () {
        const control = yield* controlOf(ctx, presence);
        const configFile = path.join(
          control.homePath || path.join(deps.home, ".codex"),
          "config.toml",
        );
        const summary = `Codex skills/config/write ${presence.path} enabled=${action.enabled}`;
        if (input.preview)
          return {
            preview: { files: [configFile], summary, liveness: "now", expected: {} },
          } satisfies ProjectSkillsActionResult;
        return yield* serialized(
          ctx.cwd,
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* deps.codexClient(control, ctx.cwd, ctx.projectId);
              const written = yield* client
                .request("skills/config/write", { path: presence.path, enabled: action.enabled })
                .pipe(Effect.mapError(codexRequestFailed(ctx, "switch the skill")));
              yield* codexReload(client, ctx.cwd);
              yield* refreshed(ctx, presence);
              // config.toml was written either way; report it so the change can be undone.
              const overridden = written.effectiveEnabled !== action.enabled;
              return {
                applied: true,
                summary,
                liveness: "now",
                effectiveEnabled: written.effectiveEnabled,
                ...(overridden
                  ? {
                      warnings: [
                        `${configFile} now says ${action.enabled ? "on" : "off"}, but a higher Codex config layer keeps ${ctx.row.name} ${written.effectiveEnabled ? "on" : "off"}.`,
                      ],
                    }
                  : {}),
              } satisfies ProjectSkillsActionResult;
            }),
          ),
        );
      });

    const toggleSkill = (
      ctx: SkillsActionContext,
      input: ProjectSkillsActionInput,
      action: ToggleSkill,
      serialized: Serialized,
    ) =>
      Effect.gen(function* () {
        const presence = yield* presenceOf(ctx, action);
        switch (presence.driver) {
          case "claudeAgent":
            if (presence.scope === "plugin")
              return yield* actionError(
                ctx.projectId,
                "scope_unsupported",
                "Claude plugin skills cannot be switched individually. Use the whole-plugin control.",
              );
            return yield* claudeSkill(ctx, input, action, presence, serialized);
          case "codex":
            return yield* codexSkill(ctx, input, action, presence, serialized);
          case "grok":
            return yield* actionError(
              ctx.projectId,
              "scope_unsupported",
              "Grok has no per-skill toggle: its ignore list hides the skill, so it could not be turned back on here.",
            );
          default:
            return yield* actionError(
              ctx.projectId,
              "scope_unsupported",
              `${presence.label} skills cannot be switched from here.`,
            );
        }
      });

    // -----------------------------------------------------------------------
    // A whole plugin
    // -----------------------------------------------------------------------

    /** The settings file `claude plugin enable|disable -s <scope>` writes. */
    const claudePluginFile = (
      control: ProviderSkillsControl,
      cwd: string,
      scope: TogglePlugin["scope"],
    ) =>
      scope === "user"
        ? path.join(control.homePath ?? path.join(deps.home, ".claude"), "settings.json")
        : path.join(cwd, ".claude", scope === "project" ? "settings.json" : "settings.local.json");

    const cliPlugin = (
      ctx: SkillsActionContext,
      input: ProjectSkillsActionInput,
      action: TogglePlugin,
      presence: ProjectSkillPresence,
      serialized: Serialized,
    ) =>
      Effect.gen(function* () {
        const control = yield* controlOf(ctx, presence);
        const claude = presence.driver === "claudeAgent";
        if (claude) {
          // The row's own plugin: `<plugin>:<skill>` is the plugin `<plugin>@<marketplace>`.
          const key = presence.name ?? ctx.row.name;
          const plugin = key.includes(":") ? key.split(":")[0] : undefined;
          if (
            plugin === undefined ||
            action.pluginId.split("@")[0] !== plugin ||
            !action.pluginId.includes("@")
          )
            return yield* actionError(
              ctx.projectId,
              "skill_not_found",
              `${ctx.row.name} is not a skill of Claude plugin ${action.pluginId}.`,
            );
        } else if (action.scope !== "user")
          return yield* actionError(
            ctx.projectId,
            "scope_unsupported",
            "Grok switches plugins for the user only.",
          );
        const args = claude
          ? claudePluginArgs(action.pluginId, action.enabled, action.scope)
          : grokPluginArgs(action.pluginId, action.enabled);
        const files = claude ? [claudePluginFile(control, ctx.cwd, action.scope)] : [];
        const liveness = LIVENESS[presence.driver] ?? "next-session";
        const summary = `${action.enabled ? "Turn on" : "Turn off"} ${presence.label} plugin ${action.pluginId}${claude ? ` (${action.scope} scope)` : ""}.`;
        const hash = files[0] === undefined ? undefined : yield* fileHash(files[0]);
        if (input.preview)
          return {
            preview: {
              argv: [claude ? "claude" : "grok", ...args],
              files,
              summary,
              liveness,
              expected: hash === undefined ? {} : { fileHash: hash },
            },
          } satisfies ProjectSkillsActionResult;
        return yield* serialized(
          ctx.cwd,
          Effect.gen(function* () {
            if (
              files[0] !== undefined &&
              input.expected?.fileHash !== undefined &&
              (yield* fileHash(files[0])) !== input.expected.fileHash
            )
              return yield* actionError(ctx.projectId, "stale");
            const result = yield* run({
              command: control.binaryPath,
              args,
              cwd: ctx.cwd,
              timeout: CLI_TIMEOUT,
              env: control.environment,
            });
            if (result.timedOut || result.exitCode !== 0)
              return yield* cliFailure(
                ctx.projectId,
                result,
                `${claude ? "claude" : "grok"} plugin`,
              );
            yield* refreshed(ctx, presence);
            // Claude merges enabledPlugins across files; a project file can outrank the scope written.
            const effective = claude
              ? ((yield* readClaudePluginEnabled({
                  configDir: control.homePath ?? path.join(deps.home, ".claude"),
                  cwd: ctx.cwd,
                  pluginId: action.pluginId,
                  platform: deps.platform,
                  environment: control.environment,
                  managedPath: deps.managedSettingsPath,
                })) ?? action.enabled)
              : action.enabled;
            return {
              applied: true,
              summary,
              liveness,
              effectiveEnabled: effective,
              ...(effective === action.enabled
                ? {}
                : {
                    warnings: [
                      `${files[0]} now says ${action.enabled ? "on" : "off"}, but another Claude settings file keeps plugin ${action.pluginId} ${effective ? "on" : "off"}.`,
                    ],
                  }),
            } satisfies ProjectSkillsActionResult;
          }),
        );
      });

    const codexPlugin = (
      ctx: SkillsActionContext,
      input: ProjectSkillsActionInput,
      action: TogglePlugin,
      presence: ProjectSkillPresence,
      serialized: Serialized,
    ) =>
      Effect.gen(function* () {
        if (action.scope !== "user")
          return yield* actionError(
            ctx.projectId,
            "scope_unsupported",
            "Codex plugins switch in the user's config.toml only.",
          );
        const control = yield* controlOf(ctx, presence);
        const configFile = path.join(
          control.homePath || path.join(deps.home, ".codex"),
          "config.toml",
        );
        const keyPath = codexPluginKeyPath(action.pluginId);
        const summary = `Codex config/value/write ${keyPath} = ${action.enabled}`;
        if (input.preview) {
          // The user layer's version, so the apply is refused if config.toml changes in between.
          const version = yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* deps.codexClient(control, ctx.cwd, ctx.projectId);
              const read = yield* client.request("config/read", {
                cwd: ctx.cwd,
                includeLayers: true,
              });
              return Option.fromNullishOr(
                (read.layers ?? []).find((layer) => layer.name.type === "user")?.version,
              );
            }),
          ).pipe(Effect.orElseSucceed(() => Option.none<string>()));
          return {
            preview: {
              files: [configFile],
              summary,
              liveness: "now",
              expected: Option.isSome(version) ? { configVersion: version.value } : {},
            },
          } satisfies ProjectSkillsActionResult;
        }
        const expectedVersion = input.expected?.configVersion;
        return yield* serialized(
          ctx.cwd,
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* deps.codexClient(control, ctx.cwd, ctx.projectId);
              const written = yield* client
                .request("config/value/write", {
                  keyPath,
                  value: action.enabled,
                  mergeStrategy: "upsert",
                  ...(expectedVersion === undefined ? {} : { expectedVersion }),
                })
                .pipe(
                  Effect.mapError((cause) =>
                    expectedVersion !== undefined &&
                    cause._tag === "CodexAppServerRequestError" &&
                    /version/i.test(cause.errorMessage)
                      ? actionError(
                          ctx.projectId,
                          "stale",
                          "Codex's config.toml changed since the preview.",
                        )
                      : codexRequestFailed(ctx, "write the plugin switch")(cause),
                  ),
                );
              yield* codexReload(client, ctx.cwd);
              yield* refreshed(ctx, presence);
              // config.toml was written either way; report it so the change can be undone.
              const overridden = written.status === "okOverridden";
              const effectiveValue = written.overriddenMetadata?.effectiveValue;
              return {
                applied: true,
                summary,
                liveness: "now",
                effectiveEnabled: overridden
                  ? typeof effectiveValue === "boolean"
                    ? effectiveValue
                    : !action.enabled
                  : action.enabled,
                ...(overridden
                  ? {
                      warnings: [
                        written.overriddenMetadata?.message ??
                          `${configFile} now says ${action.enabled}, but a higher Codex config layer overrides it.`,
                      ],
                    }
                  : {}),
              } satisfies ProjectSkillsActionResult;
            }),
          ),
        );
      });

    const togglePlugin = (
      ctx: SkillsActionContext,
      input: ProjectSkillsActionInput,
      action: TogglePlugin,
      serialized: Serialized,
    ) =>
      Effect.gen(function* () {
        const presence = yield* presenceOf(ctx, action);
        switch (presence.driver) {
          case "claudeAgent":
          case "grok":
            return yield* cliPlugin(ctx, input, action, presence, serialized);
          case "codex":
            return yield* codexPlugin(ctx, input, action, presence, serialized);
          default:
            return yield* actionError(
              ctx.projectId,
              "scope_unsupported",
              `${presence.label} plugins cannot be switched from here.`,
            );
        }
      });

    return { toggleSkill, togglePlugin };
  });
