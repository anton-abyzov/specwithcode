import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import {
  SkillAuthoringDraft,
  SkillAuthoringError,
  type SkillAuthoringInput,
  type SkillAuthoringResult,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectSkillsService from "./ProjectSkillsService.ts";
import * as SkillPublishingAdapter from "./SkillPublishingAdapter.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SkillPublishingService from "./SkillPublishingService.ts";

export class SkillAuthoringService extends Context.Service<
  SkillAuthoringService,
  {
    readonly execute: (
      input: SkillAuthoringInput,
    ) => Effect.Effect<SkillAuthoringResult, SkillAuthoringError>;
  }
>()("specweave-studio/project/SkillAuthoringService") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const skills = yield* ProjectSkillsService.ProjectSkillsService;
  const generation = yield* TextGeneration.TextGeneration;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const publishing = yield* SkillPublishingService.SkillPublishingService;
  // Locks exist only while a draft has active or queued requests.
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  const directory = path.join(config.stateDir, "skill-authoring");
  const decode = Schema.decodeUnknownEffect(SkillAuthoringDraft);
  const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(SkillAuthoringDraft));
  const encodeFile = Schema.encodeEffect(Schema.fromJsonString(SkillAuthoringDraft));
  const execute: SkillAuthoringService["Service"]["execute"] = (input) =>
    Effect.gen(function* () {
      const cwd = yield* skills
        .resolveCwd(input)
        .pipe(Effect.mapError((cause) => new SkillAuthoringError({ reason: "invalid", cause })));
      const digest = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(`${input.projectId}\0${cwd}\0${input.userLevel === true}`),
        )
        .pipe(
          Effect.mapError((cause) => new SkillAuthoringError({ reason: "read_failed", cause })),
        );
      const key = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          entry.users++;
          locks.set(key, entry);
          return entry;
        }),
        (entry) =>
          entry.semaphore.withPermit(
            Effect.gen(function* () {
              const file = path.join(directory, `${key}.json`);
              let draft: SkillAuthoringDraft | null = null;
              const exists = yield* fs
                .exists(file)
                .pipe(
                  Effect.mapError(
                    (cause) => new SkillAuthoringError({ reason: "read_failed", cause }),
                  ),
                );
              if (exists) {
                const raw = yield* fs
                  .readFileString(file)
                  .pipe(
                    Effect.mapError(
                      (cause) => new SkillAuthoringError({ reason: "read_failed", cause }),
                    ),
                  );
                draft = yield* decodeFile(raw).pipe(
                  Effect.mapError(
                    (cause) => new SkillAuthoringError({ reason: "read_failed", cause }),
                  ),
                );
              }
              if (input.draftId && input.draftId !== draft?.id)
                return yield* new SkillAuthoringError({ reason: "not_found" });
              if (input.operation === "read") return { draft };
              if (draft && input.revision !== draft.revision)
                return yield* new SkillAuthoringError({ reason: "stale" });
              const save = (next: SkillAuthoringDraft) =>
                Effect.gen(function* () {
                  const temp = `${file}.${yield* crypto.randomUUIDv4}.tmp`;
                  yield* fs.makeDirectory(directory, { recursive: true });
                  yield* fs.writeFileString(temp, yield* encodeFile(next), { mode: 0o600 });
                  yield* fs
                    .rename(temp, file)
                    .pipe(Effect.onError(() => fs.remove(temp).pipe(Effect.ignore)));
                  draft = next;
                }).pipe(
                  Effect.mapError(
                    (cause) => new SkillAuthoringError({ reason: "write_failed", cause }),
                  ),
                );
              const archive = (previous: SkillAuthoringDraft) =>
                Effect.gen(function* () {
                  const history = path.join(directory, "history", key);
                  yield* fs.makeDirectory(history, { recursive: true });
                  const destination = path.join(
                    history,
                    `${previous.id}-${previous.revision}.json`,
                  );
                  const temp = `${destination}.${yield* crypto.randomUUIDv4}.tmp`;
                  yield* fs.writeFileString(temp, yield* encodeFile(previous), { mode: 0o600 });
                  yield* fs
                    .rename(temp, destination)
                    .pipe(Effect.onError(() => fs.remove(temp).pipe(Effect.ignore)));
                }).pipe(
                  Effect.mapError(
                    (cause) => new SkillAuthoringError({ reason: "write_failed", cause }),
                  ),
                );
              if (input.operation === "new") {
                if (draft?.publication && ["queued", "reviewing"].includes(draft.publication.state))
                  return yield* new SkillAuthoringError({
                    reason: "invalid",
                    detail:
                      "Wait for the identified publication to finish before starting another skill.",
                  });
                if (draft) {
                  yield* archive(draft);
                  yield* fs
                    .remove(file)
                    .pipe(
                      Effect.mapError(
                        (cause) => new SkillAuthoringError({ reason: "write_failed", cause }),
                      ),
                    );
                }
                return { draft: null };
              }
              if (input.operation === "save" || input.operation === "generate") {
                if (!input.draft)
                  return yield* new SkillAuthoringError({
                    reason: "invalid",
                    detail: "Provide draft content to save or generate.",
                  });
                if (
                  draft?.publication &&
                  ["submitting", "unknown", "queued", "reviewing"].includes(draft.publication.state)
                )
                  return yield* new SkillAuthoringError({
                    reason: "invalid",
                    detail: "Check publication status before editing this submitted draft.",
                  });
                let content = {
                  ...input.draft,
                  ...(input.draft.sourceFrontmatter === undefined &&
                  draft?.sourceFrontmatter !== undefined
                    ? { sourceFrontmatter: draft.sourceFrontmatter }
                    : {}),
                };
                yield* Effect.try({
                  try: () =>
                    SkillPublishingService.parseSkillFrontmatter(content.sourceFrontmatter),
                  catch: () =>
                    new SkillAuthoringError({
                      reason: "invalid",
                      detail:
                        "The skill frontmatter is invalid or unsafe. Correct it before saving.",
                    }),
                });
                const priorPublication = draft?.publication;
                const sameContent =
                  draft &&
                  ["name", "description", "instructions", "version", "sourceFrontmatter"].every(
                    (key) => draft?.[key as "name"] === content[key as "name"],
                  );
                if (
                  priorPublication?.state === "published" &&
                  (!sameContent || input.operation === "generate") &&
                  content.version === draft?.version
                )
                  return yield* new SkillAuthoringError({
                    reason: "invalid",
                    detail: "Increase the version before changing a published skill.",
                  });
                if (input.operation === "generate") {
                  if (
                    !content.modelSelection ||
                    !content.prompt.trim() ||
                    !generation.generateSkill
                  )
                    return yield* new SkillAuthoringError({
                      reason: "invalid",
                      detail: "Choose an available generation model and enter a description first.",
                    });
                  // Preserve the receipt before the request save replaces the published draft,
                  // including when generation fails after that save.
                  if (draft?.publication) yield* archive(draft);
                  // Save the request first, so failure or closing the sheet never loses the user's prompt.
                  yield* save({
                    ...content,
                    id:
                      draft?.id ??
                      (yield* crypto.randomUUIDv4.pipe(
                        Effect.mapError(
                          (cause) => new SkillAuthoringError({ reason: "write_failed", cause }),
                        ),
                      )),
                    revision: (draft?.revision ?? 0) + 1,
                    updatedAt: DateTime.formatIso(yield* DateTime.now),
                  });
                  const generated = yield* generation
                    .generateSkill({
                      cwd,
                      prompt: content.prompt,
                      modelSelection: content.modelSelection,
                    })
                    .pipe(
                      Effect.mapError(
                        (cause) => new SkillAuthoringError({ reason: "generation_failed", cause }),
                      ),
                    );
                  content = { ...content, ...generated };
                }
                const next = yield* decode({
                  ...content,
                  ...(sameContent && input.operation === "save" && priorPublication
                    ? { publication: priorPublication }
                    : {}),
                  id:
                    draft?.id ??
                    (yield* crypto.randomUUIDv4.pipe(
                      Effect.mapError(
                        (cause) => new SkillAuthoringError({ reason: "write_failed", cause }),
                      ),
                    )),
                  revision: (draft?.revision ?? 0) + 1,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                }).pipe(
                  Effect.mapError((cause) => new SkillAuthoringError({ reason: "invalid", cause })),
                );
                if (draft?.publication && !sameContent) yield* archive(draft);
                yield* save(next);
                return { draft: next };
              }
              if (!draft) return yield* new SkillAuthoringError({ reason: "not_found" });
              const current = draft;
              const persist = (publication: NonNullable<SkillAuthoringDraft["publication"]>) =>
                Effect.gen(function* () {
                  yield* save({
                    ...current,
                    publication,
                    revision: (draft?.revision ?? current.revision) + 1,
                    updatedAt: DateTime.formatIso(yield* DateTime.now),
                  });
                });
              if (input.operation === "publish") {
                if (!input.publication)
                  return yield* new SkillAuthoringError({
                    reason: "invalid",
                    detail: "Choose the publication repository and visibility first.",
                  });
                // Archived receipts are immutable publication attempts, not permission to
                // repeat a POST whose outcome may have been lost across a restart.
                const history = path.join(directory, "history", key);
                const archived = yield* Effect.gen(function* () {
                  if (!(yield* fs.exists(history))) return [];
                  const entries = (yield* fs.readDirectory(history)).filter((entry) =>
                    entry.endsWith(".json"),
                  );
                  return yield* Effect.forEach(entries, (entry) =>
                    fs.readFileString(path.join(history, entry)).pipe(Effect.flatMap(decodeFile)),
                  );
                }).pipe(
                  Effect.mapError(
                    (cause) => new SkillAuthoringError({ reason: "read_failed", cause }),
                  ),
                );
                if (
                  archived.some(
                    (previous) =>
                      previous.publication &&
                      previous.name === current.name &&
                      previous.publication.version === current.version &&
                      previous.publication.repository === input.publication!.repository,
                  )
                )
                  return yield* new SkillAuthoringError({
                    reason: "invalid",
                    detail:
                      "This skill version has an archived publication attempt. Choose a new version; the previous attempt will not be submitted again.",
                  });
                yield* publishing
                  .publish({ draft: current, destination: input.publication, persist })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new SkillAuthoringError({
                          reason: "unavailable",
                          detail: cause.detail,
                          cause,
                        }),
                    ),
                  );
              } else if (input.operation === "status") {
                yield* publishing.status({ draft: current, persist }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new SkillAuthoringError({
                        reason: "unavailable",
                        detail: cause.detail,
                        cause,
                      }),
                  ),
                );
              } else {
                if (!input.apply || (input.userLevel === true && input.apply.scope === "project"))
                  return yield* new SkillAuthoringError({
                    reason: "invalid",
                    detail:
                      "Choose an application scope. User settings cannot install into a project.",
                  });
                const driverAgents: Record<string, string> = {
                  codex: "codex",
                  claudeAgent: "claude-code",
                  cursor: "cursor",
                };
                const driverHomes: Record<string, string> = {
                  codex: ".codex",
                  claudeAgent: ".claude",
                  cursor: ".cursor",
                };
                if (!input.apply.instanceIds.length)
                  return yield* new SkillAuthoringError({
                    reason: "invalid",
                    detail: "Select at least one agent to apply this skill.",
                  });
                const selectedAgents: string[] = [];
                for (const id of input.apply.instanceIds) {
                  const instance = yield* instances.getInstance(id);
                  if (!instance?.enabled || !driverAgents[instance.driverKind])
                    return yield* new SkillAuthoringError({ reason: "unavailable" });
                  const control = instance.skillsControl;
                  const environment = control?.environment;
                  if (
                    environment?.HOME &&
                    path.resolve(environment.HOME) !== path.resolve(expandHomePath("~"))
                  )
                    return yield* new SkillAuthoringError({ reason: "unavailable" });
                  const home =
                    control?.homePath ||
                    (instance.driverKind === "codex"
                      ? environment?.CODEX_HOME
                      : instance.driverKind === "claudeAgent"
                        ? environment?.CLAUDE_CONFIG_DIR
                        : undefined);
                  if (
                    home &&
                    path.resolve(expandHomePath(home)) !==
                      path.join(expandHomePath("~"), driverHomes[instance.driverKind]!)
                  )
                    return yield* new SkillAuthoringError({ reason: "unavailable" });
                  selectedAgents.push(driverAgents[instance.driverKind]!);
                }
                if (
                  new Set(selectedAgents).size !== selectedAgents.length ||
                  input.apply.agents.length !== selectedAgents.length ||
                  input.apply.agents.some((agent) => !selectedAgents.includes(agent))
                )
                  return yield* new SkillAuthoringError({
                    reason: "invalid",
                    detail:
                      "Selected agent identities do not match the requested installation targets.",
                  });
                const applyResult = yield* publishing
                  .apply({
                    draft: current,
                    cwd,
                    request: input.apply,
                    preview: input.operation === "previewApply",
                    refresh: () =>
                      Effect.gen(function* () {
                        yield* skills.invalidate({ projectId: input.projectId, cwd });
                        yield* Effect.forEach(
                          input.apply!.instanceIds,
                          (instanceId) =>
                            registry.refreshWorkspaceSnapshot({ instanceId, cwd, fresh: true }),
                          { discard: true },
                        );
                        yield* skills.invalidate({ projectId: input.projectId, cwd });
                      }),
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new SkillAuthoringError({
                          reason: "unavailable",
                          detail: cause.detail,
                          cause,
                        }),
                    ),
                  );
                return { draft, applyResult };
              }
              return { draft };
            }),
          ),
        (entry) =>
          Effect.sync(() => {
            if (--entry.users === 0) locks.delete(key);
          }),
      );
    });
  return SkillAuthoringService.of({ execute });
});
export const layer = Layer.effect(SkillAuthoringService, make).pipe(
  Layer.provide(
    SkillPublishingService.layer.pipe(
      Layer.provide(SkillPublishingAdapter.layer.pipe(Layer.provide(ProcessRunner.layer))),
    ),
  ),
);
