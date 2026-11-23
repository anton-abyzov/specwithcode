import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";
import type * as EffectCodexSchema from "@specweave-studio/effect-codex-app-server/schema";

import {
  describeMcpElicitation,
  studioMcpToolApprovalAutoResponse,
  toMcpElicitationResponse,
} from "./CodexMcpElicitation.ts";

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("studio-code tool approvals", () => {
  const delegateTask = {
    mode: "form",
    message: 'Allow the studio-code MCP server to run tool "delegate_task"?',
    serverName: "studio-code",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
    requestedSchema: { type: "object", properties: {} },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("runs without a card unless the thread asks first", () => {
    for (const runtimeMode of ["auto-accept-edits", "auto", "full-access"] as const) {
      NodeAssert.deepStrictEqual(
        studioMcpToolApprovalAutoResponse(delegateTask, { runtimeMode }),
        { action: "accept", content: {} },
        runtimeMode,
      );
    }
    NodeAssert.equal(
      studioMcpToolApprovalAutoResponse(delegateTask, { runtimeMode: "approval-required" }),
      undefined,
    );
  });

  it("follows an explicit approval policy over the mode", () => {
    NodeAssert.equal(
      studioMcpToolApprovalAutoResponse(delegateTask, {
        runtimeMode: "full-access",
        approvalPolicy: "on-request",
      }),
      undefined,
    );
    NodeAssert.equal(
      studioMcpToolApprovalAutoResponse(delegateTask, {
        runtimeMode: "approval-required",
        approvalPolicy: "never",
      })?.action,
      "accept",
    );
  });

  it("leaves other servers, untagged forms and URL requests to the person", () => {
    const fullAccess = { runtimeMode: "full-access" } as const;
    NodeAssert.equal(
      studioMcpToolApprovalAutoResponse(
        { ...delegateTask, serverName: "computer-use" },
        fullAccess,
      ),
      undefined,
    );
    const { _meta: _tag, ...untagged } = delegateTask;
    NodeAssert.equal(studioMcpToolApprovalAutoResponse(untagged, fullAccess), undefined);
    NodeAssert.equal(
      studioMcpToolApprovalAutoResponse(
        { ...delegateTask, _meta: { codex_approval_kind: "ordinary_form" } },
        fullAccess,
      ),
      undefined,
    );
    NodeAssert.equal(
      studioMcpToolApprovalAutoResponse(
        {
          mode: "url",
          message: "Sign in",
          serverName: "studio-code",
          threadId: "provider-thread-1",
          elicitationId: "elicitation-1",
          url: "https://example.com/login",
          _meta: { codex_approval_kind: "mcp_tool_call" },
        } as EffectCodexSchema.McpServerElicitationRequestParams,
        fullAccess,
      ),
      undefined,
    );
  });

  it("asks when the form needs an answer it has no default for", () => {
    NodeAssert.equal(
      studioMcpToolApprovalAutoResponse(
        {
          ...delegateTask,
          requestedSchema: {
            type: "object",
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
        },
        { runtimeMode: "auto" },
      ),
      undefined,
    );
  });
});
