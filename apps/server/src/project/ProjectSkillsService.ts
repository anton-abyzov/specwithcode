/**
 * ProjectSkillsService — which skills each agent loads in a project folder.
 *
 * Skill lists come from the provider registry's per-folder snapshots, the same
 * scans that feed the composer's `$` picker, so the view never disagrees with
 * the picker and reuses its cache. A plain read keeps a folder's existing
 * snapshot; Rescan (`refresh`) asks every provider for a fresh scan, as the
 * composer's reload does. Lockfiles, digests and the optional `vskill doctor`
 * run on top, cached briefly per folder.
 *
 * A read may name a thread's folder (`cwd`): only the project's workspace
 * root and its own thread worktrees are accepted, so the read cannot be
 * pointed at an arbitrary path on the host.
 *
 * @module project/ProjectSkillsService
 */
import {
  ProjectSkillsReadError,
  type ProjectSkillsProviderState,
  type ProjectSkillsReadInput,
  type ProjectSkillsSnapshot,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/process";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { readClaudeSkillSwitches } from "../provider/Drivers/ClaudeSkills.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { nativeSkillHarnessOf } from "./nativeSkillSwitches.ts";
import { applyNativeSkillSwitches, type NativeSkillControl } from "./projectSkillsNativeOverlay.ts";
import type { ProviderSkillSource } from "./projectSkillsInventory.ts";
import { gatherProjectSkills } from "./projectSkillsScan.ts";

/** A rescan that has not answered by then keeps running for the picker; the view uses the last scan. */
const WORKSPACE_SCAN_BUDGET_MS = 12_000;
const CACHE_TTL_MS = 15_000;
const MAX_CACHED_FOLDERS = 16;

const DRIVER_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  pi: "Pi",
};

export function providerSkillsLabel(provider: Pick<ServerProvider, "displayName" | "driver">) {
  return provider.displayName ?? DRIVER_LABELS[provider.driver] ?? provider.driver;
}

/**
 * The skills one provider reports for `cwd`, preferring its per-folder
 * snapshot and falling back to the machine-wide list when the provider does
 * not scan folders.
 */
export function providerSkillsForCwd(
  provider: ServerProvider,
  cwd: string,
  scan: "done" | "timeout",
): { readonly source: ProviderSkillSource; readonly state: ProjectSkillsProviderState } {
  const label = providerSkillsLabel(provider);
  const workspace = provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
  const skills = workspace?.skills ?? (scan === "timeout" ? [] : provider.skills);
  const state: ProjectSkillsProviderState["state"] = workspace
    ? scan === "timeout"
      ? "cached"
      : "ok"
    : scan === "timeout"
      ? "timeout"
      : provider.status === "error"
        ? "error"
        : "unsupported";
  const message =
    state === "cached"
      ? "A new scan is still running; showing the last one for this folder."
      : state === "timeout"
        ? "The folder scan did not finish in time."
        : state === "error"
          ? (provider.message ?? "The provider reported an error.")
          : state === "unsupported"
            ? "This agent reports one machine-wide skill list, not one per folder."
            : undefined;
  return {
    source: { instanceId: provider.instanceId, driver: provider.driver, label, skills },
    state: {
      instanceId: provider.instanceId,
      driver: provider.driver,
      label,
      state,
      skills: skills.length,
      ...(message ? { message } : {}),
    },
  };
}

/**
 * The folder a read scans: the workspace root when `requested` is left out,
 * else the allowed folder it names (compared after resolving `.`, `..` and
 * trailing separators), or null when it names none of them. The stored
 * spelling is returned so the providers' per-folder snapshots match.
 */
export function allowedSkillsCwd(
  resolve: (value: string) => string,
  workspaceRoot: string,
  worktrees: ReadonlyArray<string>,
  requested: string | undefined,
): string | null {
  if (requested === undefined) return workspaceRoot;
  const target = resolve(requested);
  for (const candidate of [workspaceRoot, ...worktrees])
    if (resolve(candidate) === target) return candidate;
  return null;
}

export class ProjectSkillsService extends Context.Service<
  ProjectSkillsService,
  {
    readonly read: (
      input: ProjectSkillsReadInput,
    ) => Effect.Effect<ProjectSkillsSnapshot, ProjectSkillsReadError>;
    /** The folder a read of `input` would scan, refused like a read. */
    readonly resolveCwd: (
      input: Pick<ProjectSkillsReadInput, "projectId" | "cwd" | "threadId" | "userLevel">,
    ) => Effect.Effect<string, ProjectSkillsReadError>;
    /** Forgets the cached answer for a folder, so the next read scans it again. */
    readonly invalidate: (input: {
      readonly projectId: ProjectSkillsReadInput["projectId"];
      readonly cwd: string;
    }) => Effect.Effect<void>;
  }
>()("specweave-studio/project/ProjectSkillsService") {}

/**
 * Claude's on-disk `skillOverrides` over its reported skills. A switch written a
 * moment ago shows at once, before Claude's own rescan of the folder lands.
 * Plugin skills ignore `skillOverrides`, as Claude Code does.
 */
export function withClaudeSkillSwitches(
  source: ProviderSkillSource,
  switches: ReadonlyMap<string, boolean>,
): ProviderSkillSource {
  return {
    ...source,
    skills: source.skills.map((skill) =>
      skill.scope === "user" || skill.scope === "project"
        ? { ...skill, enabled: switches.get(skill.name) ?? true }
        : skill,
    ),
  };
}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Absent in narrow test layers; then no agent's own switches are read.
  const instances = yield* Effect.serviceOption(ProviderInstanceRegistry.ProviderInstanceRegistry);
  const home = expandHomePath("~");
  const cache = yield* Ref.make(
    new Map<
      string,
      {
        readonly projectId: ProjectSkillsReadInput["projectId"];
        readonly at: number;
        readonly snapshot: ProjectSkillsSnapshot;
      }
    >(),
  );

  /**
   * Worktrees `input.cwd` may name. With a thread id only that thread is read;
   * without one, every thread of the project from a recent shell snapshot.
   */
  const projectWorktrees = (input: ProjectSkillsReadInput) => {
    const threadId = input.threadId;
    if (threadId !== undefined) {
      return projections.getThreadSummaries
        ? projections
            .getThreadSummaries(input.projectId, [threadId])
            .pipe(
              Effect.map((rows) =>
                rows.flatMap((row) => (row.worktreePath !== null ? [row.worktreePath] : [])),
              ),
            )
        : projections
            .getThreadShell(threadId)
            .pipe(
              Effect.map((thread) =>
                thread !== null &&
                thread.projectId === input.projectId &&
                thread.deletedAt === null &&
                thread.worktreePath !== null
                  ? [thread.worktreePath]
                  : [],
              ),
            );
    }
    return projections
      .getShellSnapshot({ maxAgeMs: CACHE_TTL_MS })
      .pipe(
        Effect.map((snapshot) =>
          [...snapshot.threads, ...snapshot.archivedThreads].flatMap((thread) =>
            thread.projectId === input.projectId &&
            thread.deletedAt === null &&
            thread.worktreePath !== null
              ? [thread.worktreePath]
              : [],
          ),
        ),
      );
  };

  const scanProvider = (provider: ServerProvider, cwd: string, fresh: boolean) =>
    Effect.gen(function* () {
      // Detached so a slow scan still lands in the registry for the picker.
      // Without `fresh` the registry keeps a folder's existing snapshot, so a
      // Rescan would never see a skill added or removed since the first scan.
      const fiber = yield* registry
        .refreshWorkspaceSnapshot({ instanceId: provider.instanceId, cwd, fresh })
        .pipe(Effect.forkDetach);
      const finished = yield* Fiber.join(fiber).pipe(
        Effect.timeoutOption(WORKSPACE_SCAN_BUDGET_MS),
      );
      const providers = yield* registry.getProviders;
      const current =
        providers.find((candidate) => candidate.instanceId === provider.instanceId) ?? provider;
      return providerSkillsForCwd(current, cwd, Option.isSome(finished) ? "done" : "timeout");
    });

  /** The folder `input` names, once the project's own root and worktrees allow it. */
  const cwdFor = (
    input: Pick<ProjectSkillsReadInput, "projectId" | "cwd" | "threadId" | "userLevel">,
    workspaceRoot: string,
  ) =>
    Effect.gen(function* () {
      // The machine-wide view: every agent scans the home folder, so only user-level skills show.
      if (input.userLevel === true) return home;
      const worktrees =
        input.cwd === undefined || path.resolve(input.cwd) === path.resolve(workspaceRoot)
          ? []
          : yield* projectWorktrees(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSkillsReadError({
                    projectId: input.projectId,
                    reason: "read_failed",
                    cause,
                  }),
              ),
            );
      const cwd = allowedSkillsCwd(path.resolve, workspaceRoot, worktrees, input.cwd);
      if (cwd === null) {
        return yield* new ProjectSkillsReadError({
          projectId: input.projectId,
          reason: "cwd_not_allowed",
        });
      }

      return cwd;
    });

  const projectRoot = (projectId: ProjectSkillsReadInput["projectId"]) =>
    Effect.gen(function* () {
      const project = yield* projects
        .get(projectId)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectSkillsReadError({ projectId, reason: "read_failed", cause }),
          ),
        );
      if (Option.isNone(project))
        return yield* new ProjectSkillsReadError({ projectId, reason: "project_not_found" });
      return project.value.workspaceRoot;
    });

  const resolveCwd = (
    input: Pick<ProjectSkillsReadInput, "projectId" | "cwd" | "threadId" | "userLevel">,
  ) =>
    Effect.gen(function* () {
      return yield* cwdFor(input, yield* projectRoot(input.projectId));
    });

  const invalidate = (input: {
    readonly projectId: ProjectSkillsReadInput["projectId"];
    readonly cwd: string;
  }) =>
    Ref.update(cache, (current) => {
      const next = new Map(current);
      for (const [key, entry] of next)
        if (
          entry.projectId === input.projectId &&
          path.resolve(entry.snapshot.cwd) === path.resolve(input.cwd)
        )
          next.delete(key);
      return next;
    });

  const read = (input: ProjectSkillsReadInput) =>
    Effect.gen(function* () {
      const project = yield* projects.get(input.projectId).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSkillsReadError({
              projectId: input.projectId,
              reason: "read_failed",
              cause,
            }),
        ),
      );
      if (Option.isNone(project)) {
        return yield* new ProjectSkillsReadError({
          projectId: input.projectId,
          reason: "project_not_found",
        });
      }
      const workspaceRoot = project.value.workspaceRoot;
      const now = yield* Clock.currentTimeMillis;
      // A folder answered recently was allowed then; reuse it before any
      // thread lookup, so reopening the popover costs no database read.
      if (input.refresh !== true) {
        const target = path.resolve(input.userLevel === true ? home : (input.cwd ?? workspaceRoot));
        for (const entry of (yield* Ref.get(cache)).values())
          if (
            entry.projectId === input.projectId &&
            now - entry.at < CACHE_TTL_MS &&
            path.resolve(entry.snapshot.cwd) === target
          )
            return entry.snapshot;
      }
      const cwd = yield* cwdFor(input, workspaceRoot);

      const eligible = (yield* registry.getProviders).filter(
        (provider) => provider.enabled && provider.availability !== "unavailable",
      );
      // A fresh scan drops the other providers' snapshots for this folder, so
      // fresh scans run one at a time and each result is read as it lands.
      const fresh = input.refresh === true;
      const scanned = yield* Effect.forEach(
        eligible,
        (provider) => scanProvider(provider, cwd, fresh),
        { concurrency: fresh ? 1 : "unbounded" },
      );
      // Each agent's own switch file (Grok, Gemini, Copilot, OpenCode, Pi).
      const controls = new Map<ServerProvider["instanceId"], NativeSkillControl>();
      if (Option.isSome(instances))
        for (const provider of eligible) {
          const instance = yield* instances.value.getInstance(provider.instanceId);
          const harness = nativeSkillHarnessOf(provider.driver, instance?.skillsControl?.agentId);
          if (harness !== undefined && instance?.skillsControl !== undefined)
            controls.set(provider.instanceId, {
              harness,
              environment: instance.skillsControl.environment,
            });
        }
      const claudeSwitched = yield* Effect.forEach(
        scanned,
        ({ source }) =>
          Effect.gen(function* () {
            const provider = eligible.find((p) => p.instanceId === source.instanceId);
            if (provider?.driver !== "claudeAgent" || Option.isNone(instances)) return source;
            const control = (yield* instances.value.getInstance(source.instanceId))?.skillsControl;
            if (control?.homePath === undefined) return source;
            return withClaudeSkillSwitches(
              source,
              yield* readClaudeSkillSwitches(control.homePath, cwd, control.environment),
            );
          }),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const sources = yield* applyNativeSkillSwitches({
        cwd,
        home,
        sources: claudeSwitched,
        controls,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const snapshot = yield* gatherProjectSkills({
        cwd,
        providers: sources,
        providerStates: scanned.map((entry) => entry.state),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* Ref.update(cache, (current) => {
        const key = `${input.projectId}\u0000${cwd}`;
        const next = new Map(current);
        next.delete(key);
        next.set(key, { projectId: input.projectId, at: now, snapshot });
        while (next.size > MAX_CACHED_FOLDERS) next.delete(next.keys().next().value!);
        return next;
      });
      return snapshot;
    });

  return ProjectSkillsService.of({ read, resolveCwd, invalidate });
});

export const layer = Layer.effect(ProjectSkillsService, make);
