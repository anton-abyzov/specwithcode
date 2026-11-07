// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure synchronous digest shared by renderer and adapter, compatible with vskill content hashes.
import { createHash } from "node:crypto";
import type {
  SkillPublication,
  SkillPublishDestination,
  SkillApplyRequest,
  SkillApplyResult,
  SkillAuthoringError,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { parseDocument, isScalar, visit, stringify } from "yaml";

export class SkillPublishingError extends Schema.TaggedError<SkillPublishingError>()(
  "SkillPublishingError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export interface PublishingDraft {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly version: string;
  readonly publication?: SkillPublication | undefined;
  readonly sourceFrontmatter?: string | undefined;
}
export const skillContentHash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Accept a plain, bounded YAML mapping. Reject structures that cannot round-trip safely. */
export function parseSkillFrontmatter(source: string | undefined): Record<string, unknown> {
  if (!source?.trim()) return {};
  const invalid = () =>
    new SkillPublishingError({
      detail:
        "Skill frontmatter must be valid, unique-key YAML with plain field values and mapping metadata.",
    });
  if (source.length > 20_000) throw invalid();
  const document = parseDocument(source, {
    uniqueKeys: true,
    strict: true,
    schema: "core",
    version: "1.2",
  });
  if (document.errors.length || document.warnings.length) throw invalid();
  visit(document, {
    Alias() {
      throw invalid();
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw invalid();
    },
  });
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  const plain = (item: unknown): item is Record<string, unknown> =>
    typeof item === "object" &&
    item !== null &&
    !Array.isArray(item) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(item));
  if (!plain(value) || (value.metadata !== undefined && !plain(value.metadata))) throw invalid();
  const seen = new WeakSet<object>();
  let count = 0;
  const check = (item: unknown, depth: number): void => {
    if (++count > 5000 || depth > 20) throw invalid();
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return;
    if (typeof item !== "object" || (!Array.isArray(item) && !plain(item)) || seen.has(item))
      throw invalid();
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw invalid();
      check(child, depth + 1);
    }
  };
  check(value, 0);
  return value;
}
export const renderPublishedSkill = (draft: PublishingDraft) => {
  // Keep existing publication hashes stable for drafts made before import support.
  if (draft.sourceFrontmatter === undefined)
    return `---\nname: ${JSON.stringify(draft.name)}\ndescription: ${JSON.stringify(draft.description)}\nmetadata:\n  version: ${JSON.stringify(draft.version)}\n---\n\n${draft.instructions.trim()}\n`;
  const header = parseSkillFrontmatter(draft.sourceFrontmatter);
  const metadata = (header.metadata ?? {}) as Record<string, unknown>;
  const yaml = stringify(
    {
      ...header,
      name: draft.name,
      description: draft.description,
      metadata: { ...metadata, version: draft.version },
    },
    { aliasDuplicateObjects: false },
  );
  return `---\n${yaml}---\n\n${draft.instructions.trim()}\n`;
};
const renderChecked = (draft: PublishingDraft) =>
  Effect.try({
    try: () => renderPublishedSkill(draft),
    catch: () =>
      new SkillPublishingError({
        detail: "The skill frontmatter is invalid. Correct it before publishing.",
      }),
  });

/** External boundaries only. Tests replace this service, never publication logic. */
export class SkillPublishingAdapter extends Context.Service<
  SkillPublishingAdapter,
  {
    readonly prepare: (
      destination: SkillPublishDestination,
    ) => Effect.Effect<{ tenantId?: string }, SkillPublishingError>;
    readonly upload: (
      publication: SkillPublication,
      content: string,
    ) => Effect.Effect<void, SkillPublishingError>;
    readonly submit: (
      publication: SkillPublication,
    ) => Effect.Effect<{ id: string; state: string; detail?: string }, SkillPublishingError>;
    readonly status: (
      publication: SkillPublication,
    ) => Effect.Effect<{ id: string; state: string; detail?: string }, SkillPublishingError>;
    readonly verify: (publication: SkillPublication) => Effect.Effect<void, SkillPublishingError>;
    readonly apply: (
      publication: SkillPublication,
      cwd: string,
      request: SkillApplyRequest,
      preview: boolean,
    ) => Effect.Effect<SkillApplyResult, SkillPublishingError>;
  }
>()("specweave-studio/project/SkillPublishingService/SkillPublishingAdapter") {}

type Persist = (publication: SkillPublication) => Effect.Effect<void, SkillAuthoringError>;
type PublishedInput = { readonly draft: PublishingDraft; readonly persist: Persist };
const error = (detail: string) => new SkillPublishingError({ detail });
const stateOf = (value: string): SkillPublication["state"] => {
  if (value === "PUBLISHED") return "published";
  if (["REJECTED", "TIER1_FAILED", "TIER2_FAILED"].includes(value)) return "rejected";
  if (["BLOCKED", "DEQUEUED", "FAILED", "UNSUBMITTED"].includes(value)) return "blocked";
  if (["RECEIVED", "QUEUED"].includes(value)) return "queued";
  if (["TIER1_SCANNING", "TIER2_SCANNING", "AUTO_APPROVED"].includes(value)) return "reviewing";
  return "unknown";
};
export class SkillPublishingService extends Context.Service<
  SkillPublishingService,
  {
    readonly publish: (
      input: PublishedInput & { readonly destination: SkillPublishDestination },
    ) => Effect.Effect<SkillPublication, SkillPublishingError>;
    readonly status: (
      input: PublishedInput,
    ) => Effect.Effect<SkillPublication, SkillPublishingError>;
    readonly apply: (input: {
      readonly draft: PublishingDraft;
      readonly cwd: string;
      readonly request: SkillApplyRequest;
      readonly preview: boolean;
      readonly refresh: () => Effect.Effect<void, SkillAuthoringError>;
    }) => Effect.Effect<SkillApplyResult, SkillPublishingError>;
  }
>()("specweave-studio/project/SkillPublishingService") {}

const make = Effect.gen(function* () {
  const adapter = yield* SkillPublishingAdapter;
  const save = (persist: Persist, publication: SkillPublication) =>
    persist(publication).pipe(
      Effect.mapError(() => error("Could not save publication state. No retry was attempted.")),
    );
  const checked = (draft: PublishingDraft) =>
    Effect.gen(function* () {
      const publication = draft.publication;
      const content = yield* renderChecked(draft);
      if (
        !publication ||
        publication.contentHash !== skillContentHash(content) ||
        publication.version !== draft.version
      )
        return yield* Effect.fail(
          error("The draft differs from its publication. Save a new version before publishing."),
        );
      return publication;
    });
  const reconcile = (input: PublishedInput, publication: SkillPublication) =>
    Effect.gen(function* () {
      const remote = yield* adapter.status(publication);
      if (publication.submissionId && remote.id !== publication.submissionId)
        return yield* Effect.fail(error("Submission identity did not match."));
      let next: SkillPublication = {
        ...publication,
        ...(remote.id ? { submissionId: remote.id } : {}),
        state: stateOf(remote.state),
        ...(remote.detail ? { detail: remote.detail } : {}),
      };
      if (next.state === "published") {
        const proof = yield* adapter.verify(next).pipe(Effect.result);
        if (proof._tag === "Failure")
          next = {
            ...next,
            state: "reviewing",
            detail:
              "Publication is reported, but the exact version and content are not yet verified.",
          };
      }
      yield* save(input.persist, next);
      return next;
    });
  return SkillPublishingService.of({
    publish: (input) =>
      Effect.gen(function* () {
        const { draft, destination } = input;
        if (
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name) ||
          !/^\d+\.\d+\.\d+$/.test(draft.version)
        )
          return yield* Effect.fail(
            error("Use a lowercase skill name and an exact three-part version."),
          );
        if (draft.publication) {
          const previous = yield* checked(draft);
          if (
            previous.repository !== destination.repository ||
            previous.visibility !== destination.visibility ||
            previous.tenant !== destination.tenant
          )
            return yield* Effect.fail(error("This draft already has a publication destination."));
          // A response lost after submit must never turn into an automatic second POST.
          return yield* reconcile(input, previous);
        }
        const content = yield* renderChecked(draft);
        const account = yield* adapter.prepare(destination);
        const publication: SkillPublication = {
          ...destination,
          ...account,
          state: "submitting",
          contentHash: skillContentHash(content),
          version: draft.version,
          skillId: `${destination.repository}/${draft.name}`,
          skillPath: `skills/${draft.version}/${draft.name}/SKILL.md`,
        };
        yield* adapter.upload(publication, content);
        yield* save(input.persist, publication);
        const result = yield* adapter.submit(publication).pipe(Effect.result);
        if (result._tag === "Failure") {
          const unknown: SkillPublication = {
            ...publication,
            state: "unknown",
            detail:
              "The submission response was not received. Check the publishing account before retrying; this draft will not submit twice.",
          };
          yield* save(input.persist, unknown);
          return unknown;
        }
        const next: SkillPublication = {
          ...publication,
          submissionId: result.success.id,
          state: stateOf(result.success.state),
          ...(result.success.detail ? { detail: result.success.detail } : {}),
        };
        yield* save(input.persist, next);
        return yield* reconcile(input, next);
      }).pipe(Effect.uninterruptible),
    status: (input) =>
      checked(input.draft).pipe(Effect.flatMap((publication) => reconcile(input, publication))),
    apply: (input) =>
      Effect.gen(function* () {
        const publication = yield* checked(input.draft);
        if (publication.state !== "published")
          return yield* Effect.fail(error("Apply requires a verified published version."));
        yield* adapter.verify(publication);
        const applied = yield* adapter.apply(publication, input.cwd, input.request, input.preview);
        if (!input.preview) yield* input.refresh().pipe(Effect.ignore);
        return applied;
      }),
  });
});
export const layer = Layer.effect(SkillPublishingService, make);
