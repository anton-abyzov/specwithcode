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

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
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

export class ProjectSkillsService extends Context.Service<
  ProjectSkillsService,
  {
    readonly read: (
      input: ProjectSkillsReadInput,
    ) => Effect.Effect<ProjectSkillsSnapshot, ProjectSkillsReadError>;
  }
>()("specweave-studio/project/ProjectSkillsService") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cache = yield* Ref.make(
    new Map<string, { readonly at: number; readonly snapshot: ProjectSkillsSnapshot }>(),
  );

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
      const cwd = project.value.workspaceRoot;
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(cache)).get(cwd);
      if (cached && input.refresh !== true && now - cached.at < CACHE_TTL_MS) {
        return cached.snapshot;
      }

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
      const snapshot = yield* gatherProjectSkills({
        cwd,
        providers: scanned.map((entry) => entry.source),
        providerStates: scanned.map((entry) => entry.state),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* Ref.update(cache, (current) => {
        const next = new Map(current);
        next.delete(cwd);
        next.set(cwd, { at: now, snapshot });
        while (next.size > MAX_CACHED_FOLDERS) next.delete(next.keys().next().value!);
        return next;
      });
      return snapshot;
    });

  return ProjectSkillsService.of({ read });
});

export const layer = Layer.effect(ProjectSkillsService, make);
