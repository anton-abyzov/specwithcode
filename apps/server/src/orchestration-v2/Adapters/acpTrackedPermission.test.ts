import { describe, expect, it } from "vite-plus/test";

import { parsePermissionRequest } from "../../provider/acp/AcpRuntimeModel.ts";
import { withTrackedPermissionToolCall } from "./acpTrackedPermission.ts";

const tracked = {
  toolCallId: "tool-1",
  kind: "execute",
  data: { toolCallId: "tool-1", title: "git status", rawInput: { command: "git status" } },
};
const options = [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" as const }];

describe("withTrackedPermissionToolCall", () => {
  it("fills an ID-only request from the tracked execute tool call", () => {
    const request = withTrackedPermissionToolCall(
      { sessionId: "session-1", options, toolCall: { toolCallId: "tool-1" } },
      tracked,
    );

    expect(parsePermissionRequest(request)).toMatchObject({
      kind: "execute",
      detail: "git status",
    });
  });

  it("does not grant execution when the tracked tool call is another kind", () => {
    const request = withTrackedPermissionToolCall(
      { sessionId: "session-1", options, toolCall: { toolCallId: "tool-1" } },
      { ...tracked, kind: "other" },
    );

    expect(request.toolCall.kind).toBeUndefined();
    expect(parsePermissionRequest(request)).toMatchObject({
      kind: "unknown",
      detail: "git status",
    });
  });

  it("keeps an explicit permission request kind over the tracked tool call's kind", () => {
    const request = withTrackedPermissionToolCall(
      { sessionId: "session-1", options, toolCall: { toolCallId: "tool-1", kind: "read" } },
      tracked,
    );

    expect(parsePermissionRequest(request)).toMatchObject({ kind: "read", detail: "git status" });
  });

  it("keeps explicitly cleared permission request fields over the tracked tool call", () => {
    const request = withTrackedPermissionToolCall(
      {
        sessionId: "session-1",
        options,
        toolCall: { toolCallId: "tool-1", kind: null, title: null, rawInput: null },
      },
      tracked,
    );

    expect(parsePermissionRequest(request).kind).toBe("unknown");
  });

  it("returns the request unchanged without a tracked tool call", () => {
    const request = { sessionId: "session-1", options, toolCall: { toolCallId: "tool-1" } };

    expect(withTrackedPermissionToolCall(request, undefined)).toBe(request);
  });
});
