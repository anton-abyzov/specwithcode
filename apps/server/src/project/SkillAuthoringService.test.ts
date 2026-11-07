import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, TextGenerationError } from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectSkillsService from "./ProjectSkillsService.ts";
import * as SkillPublishingService from "./SkillPublishingService.ts";
import * as Authoring from "./SkillAuthoringService.ts";
const content = {
  name: "release-notes",
  description: "Write release notes",
  instructions: "Summarize commits.",
  version: "1.0.0",
  prompt: "Draft notes",
};
const target = { projectId: ProjectId.make("authoring-test"), cwd: "/fixture" };
const fixture = Layer.mergeAll(
  Layer.mock(ProjectSkillsService.ProjectSkillsService)({
    resolveCwd: (input) => Effect.succeed(input.cwd ?? "/fixture"),
    invalidate: () => Effect.void,
  }),
  Layer.mock(TextGeneration.TextGeneration)({
    generateSkill: () =>
      Effect.fail(
        new TextGenerationError({ operation: "generateSkill", detail: "Fixture failure" }),
      ),
  }),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  Layer.mock(SkillPublishingService.SkillPublishingService)({}),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "skill-authoring-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
it.effect("preserves manual drafts across reconstruction and rejects stale edits", () =>
  Effect.gen(function* () {
    const first = yield* Authoring.make;
    expect((yield* first.execute({ ...target, operation: "read" })).draft).toBeNull();
    const saved = (yield* first.execute({ ...target, operation: "save", draft: content })).draft!;
    const reloaded = yield* Authoring.make;
    expect((yield* reloaded.execute({ ...target, operation: "read" })).draft).toEqual(saved);
    const stale = yield* reloaded
      .execute({ ...target, operation: "save", draft: content, revision: 0 })
      .pipe(Effect.result);
    expect(stale._tag).toBe("Failure");
    expect((yield* reloaded.execute({ ...target, operation: "read" })).draft).toEqual(saved);
    expect(
      (yield* reloaded.execute({ ...target, cwd: "/another", operation: "read" })).draft,
    ).toBeNull();
  }).pipe(Effect.provide(fixture)),
);
it.effect("persists the prompt and manual edits when generation fails", () =>
  Effect.gen(function* () {
    const service = yield* Authoring.make;
    const draft = {
      ...content,
      modelSelection: { instanceId: ProviderInstanceId.make("selected"), model: "chosen-model" },
    };
    const result = yield* service
      .execute({ ...target, operation: "generate", draft })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    const saved = (yield* service.execute({ ...target, operation: "read" })).draft!;
    expect(saved.prompt).toBe(content.prompt);
    expect(saved.instructions).toBe(content.instructions);
    expect(saved.modelSelection).toEqual(draft.modelSelection);
  }).pipe(Effect.provide(fixture)),
);
it.effect("serializes competing saves so only one revision wins", () =>
  Effect.gen(function* () {
    const service = yield* Authoring.make;
    const saved = (yield* service.execute({ ...target, operation: "save", draft: content })).draft!;
    const results = yield* Effect.all(
      ["first", "second"].map((instructions) =>
        service
          .execute({
            ...target,
            operation: "save",
            draft: { ...content, instructions },
            revision: saved.revision,
          })
          .pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
    expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
  }).pipe(Effect.provide(fixture)),
);
it.effect("preserves publication on unchanged save and requires a version bump for edits", () =>
  Effect.gen(function* () {
    const service = yield* Authoring.make.pipe(
      Effect.provideService(SkillPublishingService.SkillPublishingService, {
        publish: ({ draft, destination, persist }) =>
          Effect.gen(function* () {
            const publication = {
              ...destination,
              state: "published" as const,
              contentHash: "fixture",
              version: draft.version,
              skillId: "owner/repo/release-notes",
              skillPath: "skills/release-notes/SKILL.md",
            };
            yield* persist(publication);
            return publication;
          }).pipe(
            Effect.mapError(
              () =>
                new SkillPublishingService.SkillPublishingError({
                  detail: "Fixture persistence failed",
                }),
            ),
          ),
        status: () => Effect.die("unused"),
        apply: () => Effect.die("unused"),
      }),
    );
    const saved = (yield* service.execute({ ...target, operation: "save", draft: content })).draft!;
    const published = (yield* service.execute({
      ...target,
      operation: "publish",
      revision: saved.revision,
      publication: { repository: "owner/repo", visibility: "private" },
    })).draft!;
    const unchanged = (yield* service.execute({
      ...target,
      operation: "save",
      revision: published.revision,
      draft: content,
    })).draft!;
    expect(unchanged.publication?.state).toBe("published");
    const sameVersion = yield* service
      .execute({
        ...target,
        operation: "save",
        revision: unchanged.revision,
        draft: { ...content, instructions: "Changed" },
      })
      .pipe(Effect.result);
    expect(sameVersion._tag).toBe("Failure");
    const changedHeader = yield* service
      .execute({
        ...target,
        operation: "save",
        revision: unchanged.revision,
        draft: { ...content, sourceFrontmatter: "allowed-tools: [Read]" },
      })
      .pipe(Effect.result);
    expect(changedHeader._tag).toBe("Failure");
    const generated = yield* service
      .execute({
        ...target,
        operation: "generate",
        revision: unchanged.revision,
        draft: {
          ...content,
          version: "1.0.1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("selected"),
            model: "chosen-model",
          },
        },
      })
      .pipe(Effect.result);
    expect(generated._tag).toBe("Failure");
    const bumped = (yield* service.execute({ ...target, operation: "read" })).draft!;
    expect(bumped.version).toBe("1.0.1");
    expect(bumped.publication).toBeUndefined();
    // Reconstruction must still remember the prior published version even after generation failed.
    const restored = yield* Authoring.make;
    const reverted = (yield* restored.execute({
      ...target,
      operation: "save",
      revision: bumped.revision,
      draft: content,
    })).draft!;
    const replay = yield* restored
      .execute({
        ...target,
        operation: "publish",
        revision: reverted.revision,
        publication: { repository: "owner/repo", visibility: "private" },
      })
      .pipe(Effect.result);
    expect(replay._tag).toBe("Failure");
    if (replay._tag === "Failure")
      expect(String(replay.failure)).toContain("archived publication attempt");
  }).pipe(Effect.provide(fixture)),
);

it.effect("starts a new skill without overwriting the archived saved draft", () =>
  Effect.gen(function* () {
    const service = yield* Authoring.make;
    const saved = (yield* service.execute({ ...target, operation: "save", draft: content })).draft!;
    const reset = yield* service.execute({
      ...target,
      operation: "new",
      draftId: saved.id,
      revision: saved.revision,
    });
    expect(reset.draft).toBeNull();
    expect((yield* service.execute({ ...target, operation: "read" })).draft).toBeNull();
    const next = (yield* service.execute({ ...target, operation: "save", draft: content })).draft!;
    expect(next.id).not.toBe(saved.id);
  }).pipe(Effect.provide(fixture)),
);

it.effect("a pending generation does not block another project draft", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* Authoring.make.pipe(
      Effect.provide(
        Layer.mock(TextGeneration.TextGeneration)({
          generateSkill: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return { name: "sample", description: "sample", instructions: "sample" };
            }),
        }),
      ),
    );
    const generating = yield* service
      .execute({
        ...target,
        operation: "generate",
        draft: {
          ...content,
          modelSelection: {
            instanceId: ProviderInstanceId.make("selected"),
            model: "chosen-model",
          },
        },
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const other = yield* service
      .execute({ ...target, cwd: "/other-project", operation: "read" })
      .pipe(Effect.timeout("1 second"));
    expect(other.draft).toBeNull();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(generating);
  }).pipe(Effect.provide(fixture)),
);

it.effect(
  "archives an uncertain private submission without allowing the same version to be posted again",
  () =>
    Effect.gen(function* () {
      let posts = 0;
      const service = yield* Authoring.make.pipe(
        Effect.provide(
          Layer.mock(SkillPublishingService.SkillPublishingService)({
            publish: ({ draft, destination, persist }) =>
              Effect.gen(function* () {
                posts++;
                const publication = {
                  ...destination,
                  state: "unknown" as const,
                  contentHash: "fixture",
                  version: draft.version,
                  skillId: "owner/repo/release-notes",
                  skillPath: `skills/${draft.version}/release-notes/SKILL.md`,
                };
                yield* persist(publication);
                return publication;
              }).pipe(
                Effect.mapError(
                  () =>
                    new SkillPublishingService.SkillPublishingError({
                      detail: "Fixture persistence failed",
                    }),
                ),
              ),
          }),
        ),
      );
      const saved = (yield* service.execute({ ...target, operation: "save", draft: content }))
        .draft!;
      const unknown = (yield* service.execute({
        ...target,
        operation: "publish",
        revision: saved.revision,
        publication: { repository: "owner/repo", visibility: "private", tenant: "team" },
      })).draft!;
      expect(unknown.publication?.submissionId).toBeUndefined();
      expect(
        (yield* service.execute({
          ...target,
          operation: "new",
          draftId: unknown.id,
          revision: unknown.revision,
        })).draft,
      ).toBeNull();
      const next = (yield* service.execute({ ...target, operation: "save", draft: content }))
        .draft!;
      const replay = yield* service
        .execute({
          ...target,
          operation: "publish",
          revision: next.revision,
          publication: { repository: "owner/repo", visibility: "private", tenant: "team" },
        })
        .pipe(Effect.result);
      expect(replay._tag).toBe("Failure");
      expect(posts).toBe(1);
      const bumped = (yield* service.execute({
        ...target,
        operation: "save",
        revision: next.revision,
        draft: { ...content, version: "1.0.1" },
      })).draft!;
      yield* service.execute({
        ...target,
        operation: "publish",
        revision: bumped.revision,
        publication: { repository: "owner/repo", visibility: "private", tenant: "team" },
      });
      expect(posts).toBe(2);
    }).pipe(Effect.provide(fixture)),
);

it.effect("constructs the live authoring layer without an ambient process runner", () =>
  Effect.gen(function* () {
    const service = yield* Authoring.SkillAuthoringService;
    expect((yield* service.execute({ ...target, operation: "read" })).draft).toBeNull();
  }).pipe(
    Effect.provide(
      Authoring.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            FetchHttpClient.layer,
            Layer.succeed(HostProcessEnvironment, {}),
            Layer.succeed(HostProcessPlatform, "linux"),
            fixture,
          ),
        ),
      ),
    ),
  ),
);

it.effect("retains imported frontmatter through save, reload, omitted fields and generation", () =>
  Effect.gen(function* () {
    const sourceFrontmatter =
      "allowed-tools: [Read, Bash]\nmetadata:\n  version: 1.0.0\n  nested: { enabled: true, labels: [one, two] }\n";
    const service = yield* Authoring.make.pipe(
      Effect.provide(
        Layer.mock(TextGeneration.TextGeneration)({
          generateSkill: () =>
            Effect.succeed({
              name: "generated",
              description: "Generated description",
              instructions: "Generated instructions",
            }),
        }),
      ),
    );
    const saved = (yield* service.execute({
      ...target,
      operation: "save",
      draft: { ...content, sourceFrontmatter },
    })).draft!;
    const reloaded = yield* Authoring.make;
    expect(
      (yield* reloaded.execute({ ...target, operation: "read" })).draft?.sourceFrontmatter,
    ).toBe(sourceFrontmatter);
    const edited = (yield* service.execute({
      ...target,
      operation: "save",
      revision: saved.revision,
      draft: { ...content, version: "1.0.1" },
    })).draft!;
    expect(edited.sourceFrontmatter).toBe(sourceFrontmatter);
    const generated = (yield* service.execute({
      ...target,
      operation: "generate",
      revision: edited.revision,
      draft: {
        ...edited,
        modelSelection: { instanceId: ProviderInstanceId.make("selected"), model: "chosen-model" },
      },
    })).draft!;
    expect(generated.sourceFrontmatter).toBe(sourceFrontmatter);
    expect(generated.instructions).toBe("Generated instructions");
  }).pipe(Effect.provide(fixture)),
);
it.effect("rejects duplicate or unsafe frontmatter without replacing the stored draft", () =>
  Effect.gen(function* () {
    const service = yield* Authoring.make;
    const saved = (yield* service.execute({ ...target, operation: "save", draft: content })).draft!;
    for (const sourceFrontmatter of [
      "custom: one\ncustom: two",
      "metadata: { constructor: { prototype: true } }",
    ]) {
      const failure = yield* service
        .execute({
          ...target,
          operation: "save",
          revision: saved.revision,
          draft: { ...content, sourceFrontmatter },
        })
        .pipe(Effect.flip);
      expect(failure.reason).toBe("invalid");
    }
    expect((yield* service.execute({ ...target, operation: "read" })).draft).toEqual(saved);
  }).pipe(Effect.provide(fixture)),
);
