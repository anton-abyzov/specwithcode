import type * as EffectAcpSchema from "@specweave-studio/effect-acp/compat";

import type { AcpToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";

/**
 * ACP lets a permission request name its tool call by ID only. Fields the
 * request omits (undefined, not null) come from the tool call the turn is
 * already tracking, so the approval shows the real command.
 */
export function withTrackedPermissionToolCall(
  params: EffectAcpSchema.RequestPermissionRequest,
  tracked: AcpToolCallState | undefined,
): EffectAcpSchema.RequestPermissionRequest {
  if (tracked === undefined) return params;
  const { title, kind, rawInput } = params.toolCall;
  return {
    ...params,
    toolCall: {
      ...params.toolCall,
      ...(title === undefined && typeof tracked.data.title === "string"
        ? { title: tracked.data.title }
        : {}),
      // Unrecognised kinds map to command approvals, so only a tracked
      // execute kind may grant execution.
      ...(kind === undefined && tracked.kind === "execute" ? { kind: "execute" as const } : {}),
      ...(rawInput === undefined && tracked.data.rawInput !== undefined
        ? { rawInput: tracked.data.rawInput }
        : {}),
    },
  };
}
