import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  MachineHandoffPrepareInput,
  MachineHandoffReceiveInput,
  MachineHandoffError,
} from "./machineHandoff.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthSettingsWriteScope,
} from "./auth.ts";

const isPrepareInput = Schema.is(MachineHandoffPrepareInput);
const isReceiveInput = Schema.is(MachineHandoffReceiveInput);

describe("machine handoff wire and permissions", () => {
  it("gives actionable closed-category errors without exposing Git command details", () => {
    expect(new MachineHandoffError({ code: "worker_checkpoint" }).message).toContain(
      "Commit and merge",
    );
    expect(new MachineHandoffError({ code: "remote_unavailable" }).message).toContain(
      "remote access",
    );
    expect(new MachineHandoffError({ code: "storage_failed" }).message).toContain(
      "Retry the same handoff",
    );
  });
  it("requires an explicit publish choice and safe UUID", () => {
    const input = {
      projectId: "p",
      operationId: "11111111-1111-4111-8111-111111111111",
      publish: false,
    };
    expect(isPrepareInput(input)).toBe(true);
    expect(isPrepareInput({ ...input, operationId: "../escape" })).toBe(false);
    expect(isPrepareInput({ projectId: "p", operationId: input.operationId })).toBe(false);
  });
  it("never starts a destination without an explicit mode and bundle", () => {
    expect(
      isReceiveInput({
        projectId: "p",
        operationId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toBe(false);
  });
  it.each([
    [WS_METHODS.machineHandoffPrepare, { publish: false }],
    [WS_METHODS.machineHandoffReceive, { mode: "preview" }],
  ])("allows preview only with context and filesystem read grants: %s", (method, input) => {
    expect(clientRpcRequiredScopes(method, input)).toEqual([
      AuthOrchestrationReadScope,
      AuthFilesystemReadScope,
    ]);
  });
  it.each([
    [WS_METHODS.machineHandoffPrepare, { publish: true }],
    [WS_METHODS.machineHandoffReceive, { mode: "start" }],
  ])("requires every write and start grant: %s", (method, input) => {
    expect(clientRpcRequiredScopes(method, input)).toEqual([
      AuthOrchestrationReadScope,
      AuthFilesystemReadScope,
      AuthFilesystemWriteScope,
      AuthSourceControlWriteScope,
      AuthOrchestrationOperateScope,
      ...(method === WS_METHODS.machineHandoffReceive ? [AuthSettingsWriteScope] : []),
    ]);
  });
});
