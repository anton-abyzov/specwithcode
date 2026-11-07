import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const SkillPublishDestination = Schema.Struct({
  repository: Schema.String,
  visibility: Schema.Literals(["private", "public"]),
  tenant: Schema.optional(Schema.String),
});
export type SkillPublishDestination = typeof SkillPublishDestination.Type;
export const SkillPublication = Schema.Struct({
  ...SkillPublishDestination.fields,
  state: Schema.Literals([
    "submitting",
    "unknown",
    "queued",
    "reviewing",
    "rejected",
    "blocked",
    "published",
  ]),
  contentHash: Schema.String,
  version: Schema.String,
  skillId: Schema.String,
  skillPath: Schema.String,
  submissionId: Schema.optional(Schema.String),
  tenantId: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});
export type SkillPublication = typeof SkillPublication.Type;
export const SkillApplyRequest = Schema.Struct({
  scope: Schema.Literals(["project", "user"]),
  agents: Schema.Array(Schema.String),
  instanceIds: Schema.Array(ProviderInstanceId),
  expectedHash: Schema.optional(Schema.String),
});
export type SkillApplyRequest = typeof SkillApplyRequest.Type;
export const SkillApplyResult = Schema.Struct({
  preview: Schema.Boolean,
  expectedHash: Schema.String,
  files: Schema.Array(Schema.String),
  summary: Schema.String,
  installedVersion: Schema.optional(Schema.String),
  ready: Schema.Boolean,
});
export type SkillApplyResult = typeof SkillApplyResult.Type;
