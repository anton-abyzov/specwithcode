import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  CLIENT_GUARDED_RPC_SCOPES,
  WS_METHODS,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { handoffBatchGate } from "./handoffBatch";

describe("the hand off batch from a window (1390 AC-33)", () => {
  it("is guarded at the scopes the gate is asked about", () => {
    expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.handoffBatchStart]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.handoffBatchRead]).toBe(AuthFilesystemReadScope);
  });

  it("lets a window with full access start a batch", () => {
    expect(handoffBatchGate({ machine: "Rack F", operate: "granted", read: "granted" })).toEqual({
      canRead: true,
      canStart: true,
      blocked: null,
    });
  });

  it("greys Hand off for a window that can only read the machine, and still reads the batch", () => {
    expect(handoffBatchGate({ machine: "Rack F", operate: "denied", read: "granted" })).toEqual({
      canRead: true,
      canStart: false,
      blocked: { text: "This window can only read {machine}", values: { machine: "Rack F" } },
    });
  });

  it("starts nothing while the window's access is not known", () => {
    for (const operate of ["unknown", "signed-out", undefined] as const) {
      const gate = handoffBatchGate({ machine: "Rack F", operate, read: "unknown" });
      expect(gate.canStart).toBe(false);
      expect(gate.canRead).toBe(false);
      expect(gate.blocked).not.toBeNull();
    }
  });
});
