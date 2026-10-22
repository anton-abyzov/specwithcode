import {
  DesignOwnerInput,
  DesignSystemFinding,
  DesignSystemId,
  DesignSystemProposalSummary,
  DesignSystemScanResult,
  DesignTokenType,
  OrchestratorMcpFailure,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { DesignSystemService } from "../../../design/systems/DesignSystemService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    DesignSystemService,
    ThreadManagement.ThreadManagementService,
    ManagedProjectFolders.ManagedProjectFolders,
    McpInvocationContext.McpInvocationContext,
  ],
};

const owner = Schema.optional(DesignOwnerInput).annotate({
  description:
    "Omit it: a thread works only with its own project's design systems (the Playground's for a Scratch thread).",
});

const REVIEW =
  "Nothing is written: the user reviews the proposal in Settings > Design systems, unticks what they do not want and confirms. Tell the user it is waiting there.";

/** What an agent gets back from a proposal: enough to tell the user what to review. */
const ProposalReport = Schema.Struct({
  proposal: DesignSystemProposalSummary,
  findings: Schema.Array(DesignSystemFinding),
  next: Schema.String,
});

const DescribedToken = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Token name, such as surface-canvas or --ink (the leading -- is dropped).",
  }),
  type: Schema.optional(DesignTokenType).annotate({
    description: "Inferred from the name and value when omitted.",
  }),
  group: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  value: Schema.Union([
    Schema.String.check(Schema.isMaxLength(500)),
    Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(500))),
  ]).annotate({
    description:
      'A CSS value, or one per mode such as {"light":"#111","dark":"#eee"}. A plain value applies to the first mode.',
  }),
});

export const DESIGN_SYSTEM_TOOL_NAMES = ["design_system_scan", "design_system_propose"] as const;

export const DesignSystemsToolkit = Toolkit.make(
  Tool.make("design_system_scan", {
    ...shared,
    description: `Find the design tokens and components in this thread's project code (CSS custom properties, DTCG or Figma variable exports, Weave tokens.json, TypeScript theme objects, React component folders) and propose a design system from them. Returns the candidate files, the suggested systems with their paths, and a proposal for the suggestion you pick (key), the paths you pass, or the first suggestion. Reads only inside the project checkout. ${REVIEW}`,
    parameters: Schema.Struct({
      owner,
      suggestion: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
        description: "A suggestion key from an earlier scan.",
      }),
      paths: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMaxLength(1_000))).check(Schema.isMaxLength(40)),
      ).annotate({ description: "Project-relative candidate paths to propose from instead." }),
      name: Schema.optional(Schema.String.check(Schema.isMaxLength(180))),
      targetSystemId: Schema.optional(DesignSystemId).annotate({
        description: "Update this existing system instead of proposing a new one.",
      }),
    }),
    success: Schema.Struct({
      scan: DesignSystemScanResult,
      proposal: Schema.NullOr(DesignSystemProposalSummary),
      findings: Schema.Array(DesignSystemFinding),
      next: Schema.String,
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("design_system_propose", {
    ...shared,
    description: `Propose a design system you describe: its name, modes (such as light and dark) and tokens with a value per mode. Use it when the user describes a look in words, or to propose changes to an existing system (targetSystemId; omitted tokens show as removed). ${REVIEW}`,
    parameters: Schema.Struct({
      owner,
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(180)),
      description: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
      modes: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMaxLength(60))).check(Schema.isMaxLength(12)),
      ),
      tokens: Schema.Array(DescribedToken).check(Schema.isMinLength(1), Schema.isMaxLength(600)),
      targetSystemId: Schema.optional(DesignSystemId),
    }),
    success: ProposalReport,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
