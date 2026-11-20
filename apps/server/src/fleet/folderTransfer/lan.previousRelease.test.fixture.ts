/**
 * The previous release's side of a folder copy, as far as the local-network
 * path touches it, copied from tag `v1.0.386`. Each block names the file it
 * came from. Nothing here imports this version's folder copy code or its
 * contract for these shapes, so a change there cannot move what the previous
 * release does.
 *
 * Used by `twoServer.lan.test.ts` to run this version against that release in
 * both directions: a v1.0.386 destination that does not know `lanCheck`, and a
 * v1.0.386 source that never sends it.
 */
import {
  EnvironmentId,
  MachineHandoffOperationId,
  ProjectId,
  ProjectLinkAcceptInput,
  ProjectLinkAcceptResult,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

export const PREVIOUS_RELEASE = "v1.0.386";

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/* packages/contracts/src/folderCopy.ts */

const scopeFields = {
  copyRoot: Schema.optional(bounded(4096)),
  projectRelativePath: Schema.optional(bounded(4096)),
};
const FolderCopyMode = Schema.Literals(["copy-only", "copy-and-move"]);
const FolderCopyFileClass = Schema.Literals([
  "repository",
  "tracked",
  "untracked",
  "ignoredData",
  "rebuildable",
  "secret",
]);
const FolderCopyState = Schema.Literals([
  "planned",
  "scanning",
  "previewed",
  "approved",
  "transferring",
  "verifying",
  "applying",
  "applied",
  "undone",
  "failed",
  "cancelled",
]);

export const FolderCopyCapabilities = Schema.Struct({
  scopeVersion: Schema.Literal(1),
  contextRetention: Schema.optional(Schema.Literal(1)),
  existingCopyUpdate: Schema.optional(Schema.Literal(1)),
});

export const FolderCopyOfferInput = Schema.Struct({
  projectId: ProjectId,
  operationId: MachineHandoffOperationId,
  mode: FolderCopyMode,
  destinationEnvironmentId: EnvironmentId,
  copyRoot: Schema.optional(bounded(4096)),
});

export const FolderCopyStartInput = Schema.Struct({
  ...scopeFields,
  operationId: MachineHandoffOperationId,
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  sourceUrl: bounded(2048),
  sourceConnectUrl: Schema.optional(bounded(2048)),
  sourceMachine: bounded(200),
  token: bounded(4096),
  title: bounded(1000),
  mode: FolderCopyMode,
  targetFolder: bounded(4096),
  selection: Schema.optional(Schema.Array(FolderCopyFileClass)),
  projectId: Schema.optional(ProjectId),
  purpose: Schema.optional(Schema.Literals(["add-to-machine", "review"])),
});

/* apps/server/src/fleet/folderTransfer/agentCopy.ts */

export const AgentCopyReceiveInput = Schema.Struct({
  action: Schema.Literals(["check", "start", "status", "link", "secretsCheck", "secretsKey"]),
  targetFolder: Schema.optional(bounded(4096)),
  start: Schema.optional(FolderCopyStartInput),
  operationId: Schema.optional(MachineHandoffOperationId),
  link: Schema.optional(ProjectLinkAcceptInput),
});

export const AgentCopyReceiveResult = Schema.Struct({
  targetFolder: Schema.optional(bounded(4096)),
  state: Schema.optional(FolderCopyState),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  projectFolder: Schema.optional(bounded(4096)),
  filesDone: Schema.optional(Schema.Number),
  filesTotal: Schema.optional(Schema.Number),
  link: Schema.optional(ProjectLinkAcceptResult),
  sealedSecrets: Schema.optional(Schema.Boolean),
  secretsKey: Schema.optional(bounded(512)),
});

/* apps/server/src/fleet/folderTransfer/sourceRoutes.ts: the routes that release serves. */

export const SOURCE_ROUTES = [
  "POST validate",
  "GET hello",
  "POST manifest",
  "GET manifest",
  "POST chunks",
  "POST stat",
  "POST refresh",
  "POST ancestry",
  "POST release",
  "GET secrets",
  "POST secret",
  "POST commit",
] as const;
