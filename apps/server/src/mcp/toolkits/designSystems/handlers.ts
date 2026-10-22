import {
  type DesignError,
  type DesignOwnerInput,
  type DesignSystemProposal,
  OrchestratorMcpFailure,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import {
  DesignSystemService,
  type DesignSystemCaller,
  proposalSummary,
} from "../../../design/systems/DesignSystemService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Access from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { unavailable } from "../../threadAccess.ts";
import { DesignSystemsToolkit } from "./tools.ts";

const MAX_FINDINGS = 20;

/** The calling thread, limited to its own project (the Playground for a Scratch thread). */
const designSystemCaller = Effect.fn("mcp.designSystems.caller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const thread =
    scope.thread === undefined
      ? null
      : yield* threads.getThreadShell(scope.thread.threadId).pipe(Effect.mapError(unavailable));
  if (thread === null || thread.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const playground = yield* folders.isScratch(thread.projectId);
  return {
    actor: {
      kind: "agent",
      threadId: thread.id,
      provider: String(thread.modelSelection.instanceId).slice(0, 80),
      model: thread.modelSelection.model.slice(0, 120),
    },
    audience: "agents",
    scope: playground ? { kind: "playground" } : { kind: "project", projectId: thread.projectId },
  } satisfies DesignSystemCaller;
});

const failure = (error: DesignError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "forbidden"
        ? "capability_denied"
        : error.code === "operation_failed"
          ? "orchestration_error"
          : "invalid_request",
    message: error.detail,
  });

const ownerFor = (caller: DesignSystemCaller, owner: DesignOwnerInput | undefined) =>
  owner ?? caller.scope!;

const report = (proposal: DesignSystemProposal) => {
  const counts = proposalSummary(proposal).counts;
  return {
    proposal: proposalSummary(proposal),
    findings: proposal.findings.slice(0, MAX_FINDINGS),
    next: `Proposal ${proposal.id} for "${proposal.system.name}": ${counts.added} new, ${counts.changed} changed, ${counts.removed} removed, ${proposal.components.length} components. The user reviews and confirms it in Settings > Design systems; nothing is written until then.`,
  };
};

export const layer = Access.toLayer(DesignSystemsToolkit, {
  design_system_scan: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* designSystemCaller();
      const owner = ownerFor(caller, input.owner);
      const systems = yield* DesignSystemService;
      const scan = yield* systems.scan(caller, { owner }).pipe(Effect.mapError(failure));
      const suggestion =
        input.suggestion === undefined
          ? scan.suggestions.find((candidate) => candidate.paths.length > 0)
          : scan.suggestions.find((candidate) => candidate.key === input.suggestion);
      if (input.suggestion !== undefined && suggestion === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `No suggestion "${input.suggestion}". Keys: ${scan.suggestions.map((candidate) => candidate.key).join(", ") || "none"}.`,
        });
      }
      const paths = input.paths ?? suggestion?.paths ?? [];
      if (paths.length === 0) {
        return {
          scan,
          proposal: null,
          findings: [],
          next: "No design tokens or components were found in this project. Use design_system_propose to describe one.",
        };
      }
      const name = input.name ?? (input.paths === undefined ? suggestion?.name : undefined);
      const proposal = yield* systems
        .propose(caller, {
          owner,
          from: {
            kind: "code",
            paths,
            ...(name === undefined ? {} : { name }),
            ...(input.targetSystemId === undefined ? {} : { targetSystemId: input.targetSystemId }),
          },
        })
        .pipe(Effect.mapError(failure));
      return { scan, ...report(proposal) };
    }),
  ),
  design_system_propose: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* designSystemCaller();
      const systems = yield* DesignSystemService;
      const proposal = yield* systems
        .proposeDescribed(caller, ownerFor(caller, input.owner), {
          name: input.name,
          tokens: input.tokens.map((token) => ({
            name: token.name,
            value: token.value,
            ...(token.type === undefined ? {} : { type: token.type }),
            ...(token.group === undefined ? {} : { group: token.group }),
            ...(token.description === undefined ? {} : { description: token.description }),
          })),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.modes === undefined ? {} : { modes: input.modes }),
          ...(input.targetSystemId === undefined ? {} : { targetSystemId: input.targetSystemId }),
        })
        .pipe(Effect.mapError(failure));
      return report(proposal);
    }),
  ),
});
