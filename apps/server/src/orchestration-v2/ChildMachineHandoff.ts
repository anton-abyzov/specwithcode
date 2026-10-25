import type {
  EnvironmentId,
  HandoffChildDisposition,
  OrchestrationV2AppThread,
  OrchestrationV2Subagent,
} from "@specweave-studio/contracts";
import { childContinuationContext } from "./ChildContinuationContext.ts";

/** A local PID/session lookup has no authority over a remote or fenced copy. */
export function localChildOwnership(
  thread: Pick<OrchestrationV2AppThread, "execution" | "movedTo">,
  local: EnvironmentId | null,
): boolean {
  if (thread.movedTo?.kind === "handoff") return false;
  if (thread.execution == null) return true;
  return local !== null && thread.execution.executionMachineId === local;
}

export function childHandoffDisposition(input: {
  readonly child: OrchestrationV2Subagent;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly ownerEpoch: number;
  readonly parentInstructions: string;
  readonly remote?: boolean;
  readonly effects?: ReadonlyArray<{
    readonly id: string;
    readonly target: string;
    readonly outcome: string;
  }>;
}): HandoffChildDisposition {
  const child = input.child;
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(child.status);
  return {
    taskId: child.id,
    parentThreadId: child.threadId,
    childThreadId: child.childThreadId,
    sourceEnvironmentId: input.sourceEnvironmentId,
    ownerEpoch: input.ownerEpoch,
    origin: child.origin,
    providerThreadId: child.providerThreadId,
    status: child.status,
    disposition: terminal
      ? "settled"
      : input.remote || child.origin === "provider_native" || child.childThreadId === null
        ? "unknown"
        : "leased",
    context: childContinuationContext({
      child,
      parentInstructions: input.parentInstructions,
      ...(input.effects === undefined ? {} : { effects: input.effects }),
    }),
  };
}

/** Native processes never migrate with a transcript; a lease reference never launches a copy. */
export function childHandoffInstructions(children: ReadonlyArray<HandoffChildDisposition>): string {
  if (children.length === 0) return "";
  return [
    "Child execution dispositions. Do not start replacements for leased or unknown children. Query the owning host; local absence is not death. A settled person's Stop remains final. Existing lease epochs, grants and side-effect receipts remain authoritative.",
    ...children.map(
      (child) =>
        `Child ${child.taskId}: ${child.disposition}; owner ${child.sourceEnvironmentId}; epoch ${child.ownerEpoch}; thread ${child.childThreadId ?? "unavailable"}.\n${child.context}`,
    ),
  ].join("\n\n");
}
