import {
  DesignApplyInput,
  DesignCreateInput,
  DesignGetResult,
  DesignHistoryResult,
  DesignId,
  DesignListResult,
  DesignNodeId,
  DesignOwnerInput,
  DesignSystemGetResult,
  DesignSystemId,
  DesignSystemListResult,
  EnvironmentId,
  NonNegativeInt,
  OrchestratorMcpFailure,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as DesignService from "../../../design/DesignService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    DesignService.DesignService,
    ThreadManagement.ThreadManagementService,
    ManagedProjectFolders.ManagedProjectFolders,
    ServerEnvironment.ServerEnvironmentIdentity,
    McpInvocationContext.McpInvocationContext,
  ],
};

const owner = Schema.optional(DesignOwnerInput).annotate({
  description:
    'Whose design: {"kind":"project","projectId":...} or {"kind":"playground"}. Omit it inside a thread for the thread\'s own project (the Playground for a Scratch thread); a thread can use no other owner.',
});

const OWNERSHIP =
  "Designs belong to a project (files under .specweave/design/ in its checkout) or to the user's Playground. A thread works only with its own owner's designs.";

const designId = DesignId.annotate({
  description: "The design id from design_list or design_create.",
});

export const DESIGN_TOOL_NAMES = [
  "design_list",
  "design_get",
  "design_create",
  "design_apply",
  "design_history",
  "design_save_version",
  "design_restore",
  "design_screenshot",
  "design_system_list",
  "design_system_get",
] as const;

export const DesignToolkit = Toolkit.make(
  Tool.make("design_list", {
    ...shared,
    description: `List designs and slide decks you can open, newest first, with their revision, page count, design system and bound thread. ${OWNERSHIP}`,
    parameters: Schema.Struct({ owner }),
    success: DesignListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("design_get", {
    ...shared,
    description:
      "Read a design document: pages, nodes (frame, rect, ellipse, line, path, text, image, note, html, component), comments, design system and revision. Pass revision to read a kept autosave or named version. Pass environmentId when a reference names another machine's project: it opens from this machine's linked checkout, or fails with not_on_this_machine and the member that has it.",
    parameters: Schema.Struct({
      designId,
      owner,
      revision: Schema.optional(NonNegativeInt),
      environmentId: Schema.optional(EnvironmentId),
    }),
    success: DesignGetResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("design_create", {
    ...shared,
    description: `Create a design (kind "design", one 1440x1024 frame) or slide deck (kind "slides", one 1920x1080 slide) and return it at revision 0. It is bound to this thread unless bindThread is false. Use the owner's design system id from design_system_list for designSystem. ${OWNERSHIP}`,
    parameters: Schema.Struct({
      owner,
      kind: DesignCreateInput.fields.kind,
      title: DesignCreateInput.fields.title,
      designSystem: Schema.optional(Schema.NullOr(DesignSystemId)),
      bindThread: Schema.optional(Schema.Boolean).annotate({
        description:
          "Bind the design to this thread so the user can open the chat from it. Default true.",
      }),
    }),
    success: DesignGetResult,
  }).annotate(Tool.Destructive, false),
  Tool.make("design_apply", {
    ...shared,
    description:
      "Apply operations to a design atomically: add_node, update_node (patch; null removes a field), delete_node, move_node, add_page, update_page, delete_page, move_page, set_title, set_design_system, add_comment (the server records you as author), resolve_comment, delete_comment, set_thread (your own thread, or null to clear your own binding). Node x/y are relative to the parent frame. Pass expectedRevision from your last read: if the design changed meanwhile the call fails with the current revision; call design_get, rebuild the operations and apply again. The design's access setting may allow agents only comments or nothing.",
    parameters: Schema.Struct({
      designId,
      owner,
      expectedRevision: DesignApplyInput.fields.expectedRevision,
      operations: DesignApplyInput.fields.operations,
    }),
    success: DesignGetResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("design_history", {
    ...shared,
    description:
      "List a design's autosave revisions (the last 100) and named versions, newest first, with who saved each.",
    parameters: Schema.Struct({ designId, owner }),
    success: DesignHistoryResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("design_save_version", {
    ...shared,
    description:
      "Save the current design as a named, immutable version. Versions are committed with the project; autosaves are not.",
    parameters: Schema.Struct({
      designId,
      owner,
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(180)),
    }),
    success: DesignHistoryResult,
  }).annotate(Tool.Destructive, false),
  Tool.make("design_restore", {
    ...shared,
    description:
      "Make a new revision with the content of a past revision or named version. Nothing is lost: the current state stays in history.",
    parameters: Schema.Struct({
      designId,
      owner,
      revision: NonNegativeInt.annotate({ description: "The revision or version to restore." }),
      expectedRevision: NonNegativeInt.annotate({ description: "The current revision." }),
    }),
    success: DesignGetResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("design_system_list", {
    ...shared,
    description: `List the design systems you can use (tokens with per-mode values, components with previews). ${OWNERSHIP} Another owner's system must be copied by the user first.`,
    parameters: Schema.Struct({ owner }),
    success: DesignSystemListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("design_system_get", {
    ...shared,
    description:
      'Read a design system: modes, tokens (with resolved values and file:line provenance), components (import path, props, variants, preview HTML) and its stylesheet. Reference tokens in nodes as {"token": name}.',
    parameters: Schema.Struct({ systemId: DesignSystemId, owner }),
    success: DesignSystemGetResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);

// Image tools fail as errors, not returned payloads: their success must carry the PNG.
const { failureMode: _returned, ...imageShared } = shared;

export const DesignScreenshotTool = Tool.make("design_screenshot", {
  ...imageShared,
  description:
    "See a design: a PNG of one frame (frameId) or a whole page, rendered by headless Chrome exactly as exported. Defaults to the first page. Check your work with it after design_apply. A failure is text that starts with its code: capability_denied, invalid_request or orchestration_error.",
  parameters: Schema.Struct({
    designId,
    owner,
    pageId: Schema.optional(Schema.String),
    frameId: Schema.optional(DesignNodeId),
    scale: Schema.optional(Schema.Literals([1, 2])),
    mode: Schema.optional(
      Schema.String.annotate({
        description: "Design-system mode to resolve tokens in, such as dark.",
      }),
    ),
    includeImage: Schema.optional(
      Schema.Boolean.annotate({ description: "Default true; false returns only the size." }),
    ),
  }),
  success: Schema.Struct({
    designId: Schema.String,
    pageId: Schema.String,
    frameId: Schema.optional(Schema.String),
    revision: NonNegativeInt,
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
    }),
  }),
})
  .annotate(Tool.Title, "Design screenshot")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DesignScreenshotToolkit = Toolkit.make(DesignScreenshotTool);
