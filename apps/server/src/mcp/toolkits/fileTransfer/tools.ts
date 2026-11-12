import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as ProjectActionRequests from "../../../project/ProjectActionRequests.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerConfig.ServerConfig,
    ProjectService.ProjectService,
  ],
};

const Direction = Schema.Literals(["get", "send"]);

export const FileTransferResult = Schema.Struct({
  status: Schema.Literals(["done", "running", "awaiting_user"]),
  transferId: Schema.optional(Schema.String),
  approvalId: Schema.optional(Schema.String),
  /** Where the file now is, on `machine`. */
  path: Schema.optional(Schema.String),
  machine: Schema.optional(Schema.String),
  sizeBytes: Schema.optional(Schema.Number),
  sha256: Schema.optional(Schema.String),
  secret: Schema.optional(Schema.Boolean),
  message: Schema.String,
});

const FileTransferTool = Tool.make("studio_file_transfer", {
  ...shared,
  dependencies: [...shared.dependencies, ProjectActionRequests.ProjectActionRequests],
  description:
    'Move one file between this machine and another machine in the owner\'s fleet, over the fleet connection the user already allowed. direction "get" brings path from that machine here; "send" takes path from here to that machine. It verifies the file by SHA-256, never overwrites, and keeps nothing partial. Decide first: rebuild instead when the sources and toolchain are on this machine and that is cheap; use this for a file that is costly or impossible to rebuild, and to send files before studio_thread_launch or studio_thread_migrate on that machine (ignored files such as .env do not travel with a project). Without destinationPath the file lands in a new folder of its own in that machine\'s transfer inbox; the result names the path. A secret (a .env, keystore or service-account key, by name or content, up to 1 MB) needs the owner: the first call returns awaiting_user and an approval card; end your turn, then call again with the same arguments and approvalId. It travels encrypted and lands readable only by the owner. Never read, print or paste a secret. Grants are the user\'s: this never creates or widens one. A long transfer returns running with a transferId; pass that alone to read it. Not for folders: studio_project_add_to_machine puts a whole project folder on another machine; archive any other folder first.',
  parameters: Schema.Struct({
    machine: Schema.optional(
      Schema.String.annotate({ description: "A machine id or label from studio_machine_list." }),
    ),
    direction: Schema.optional(Direction),
    path: Schema.optional(
      Schema.String.annotate({
        description: "Absolute path, or ~/..., on the machine that holds the file.",
      }),
    ),
    destinationPath: Schema.optional(
      Schema.String.annotate({
        description:
          "Where to save it on the receiving machine, inside a folder this transfer may reach.",
      }),
    ),
    reason: Schema.optional(
      Schema.String.annotate({ description: "Shown on the owner's card for a secret." }),
    ),
    approvalId: Schema.optional(Schema.String),
    transferId: Schema.optional(Schema.String),
  }),
  success: FileTransferResult,
})
  .annotate(Tool.Title, "Move a file between machines")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const FileOfferAnswer = Schema.Struct({
  offerId: Schema.NullOr(Schema.String),
  /** Where a sent file will land; null when this machine serves it. */
  path: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  sizeBytes: Schema.NullOr(Schema.Number),
  sha256: Schema.NullOr(Schema.String),
  secret: Schema.Boolean,
  /** A secret's bytes, encrypted to recipientKey. */
  sealed: Schema.NullOr(Schema.String),
  /** The key a sent secret must be encrypted to. */
  recipientKey: Schema.NullOr(Schema.String),
});

const FileOfferTool = Tool.make("studio_file_offer", {
  ...shared,
  description:
    "Internal, between SpecWithCode machines: opens this machine's side of a studio_file_transfer. Agents never call this.",
  parameters: Schema.Struct({
    direction: Direction,
    path: Schema.optional(Schema.String),
    recipientKey: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    sizeBytes: Schema.optional(Schema.Number),
    sha256: Schema.optional(Schema.String),
    secret: Schema.optional(Schema.Boolean),
    destinationPath: Schema.optional(Schema.String),
  }),
  success: FileOfferAnswer,
})
  .annotate(Tool.Title, "Open a file transfer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const FileChunkAnswer = Schema.Struct({
  data: Schema.NullOr(Schema.String),
  last: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
});

const FileChunkTool = Tool.make("studio_file_chunk", {
  ...shared,
  description:
    "Internal, between SpecWithCode machines: carries one piece of a studio_file_transfer. Agents never call this.",
  parameters: Schema.Struct({
    offerId: Schema.String,
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    data: Schema.optional(Schema.String),
    sealed: Schema.optional(Schema.String),
    abort: Schema.optional(Schema.Boolean),
  }),
  success: FileChunkAnswer,
})
  .annotate(Tool.Title, "Carry a piece of a file")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const FileTransferToolkit = Toolkit.make(FileTransferTool, FileOfferTool, FileChunkTool);
