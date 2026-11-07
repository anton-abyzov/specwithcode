import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  SkillPublication,
  SkillPublishDestination,
  SkillApplyRequest,
  SkillApplyResult,
} from "./skillPublication.ts";
import { ModelSelection } from "./modelSelection.ts";

const boundedText = (max: number) => Schema.String.check(Schema.isMaxLength(max));
export const SkillAuthoringContent = Schema.Struct({
  name: boundedText(100),
  description: boundedText(2000),
  instructions: boundedText(100_000),
  version: boundedText(100),
  prompt: boundedText(20_000),
  /** Original YAML mapping, retained while the editable core fields change. */
  sourceFrontmatter: Schema.optional(boundedText(20_000)),
  modelSelection: Schema.optional(ModelSelection),
});
export type SkillAuthoringContent = typeof SkillAuthoringContent.Type;
export const SkillAuthoringDraft = Schema.Struct({
  ...SkillAuthoringContent.fields,
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  updatedAt: Schema.String,
  publication: Schema.optional(SkillPublication),
});
export type SkillAuthoringDraft = typeof SkillAuthoringDraft.Type;
export const SkillAuthoringInput = Schema.Struct({
  projectId: ProjectId,
  cwd: Schema.optional(Schema.String),
  threadId: Schema.optional(ThreadId),
  userLevel: Schema.optional(Schema.Boolean),
  operation: Schema.Literals([
    "read",
    "new",
    "save",
    "generate",
    "publish",
    "status",
    "previewApply",
    "apply",
  ]),
  draftId: Schema.optional(SkillAuthoringDraft.fields.id),
  revision: Schema.optional(SkillAuthoringDraft.fields.revision),
  draft: Schema.optional(SkillAuthoringContent),
  publication: Schema.optional(SkillPublishDestination),
  apply: Schema.optional(SkillApplyRequest),
});
export type SkillAuthoringInput = typeof SkillAuthoringInput.Type;
export const SkillAuthoringResult = Schema.Struct({
  draft: Schema.NullOr(SkillAuthoringDraft),
  applyResult: Schema.optional(SkillApplyResult),
});
export type SkillAuthoringResult = typeof SkillAuthoringResult.Type;
export class SkillAuthoringError extends Schema.TaggedError<SkillAuthoringError>()(
  "SkillAuthoringError",
  {
    reason: Schema.Literals([
      "read_failed",
      "write_failed",
      "invalid",
      "stale",
      "not_found",
      "generation_failed",
      "unavailable",
    ]),
    cause: Schema.optional(Schema.Defect()),
    detail: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  },
) {
  override get message() {
    return this.detail ?? `Skill authoring: ${this.reason.replaceAll("_", " ")}.`;
  }
}
