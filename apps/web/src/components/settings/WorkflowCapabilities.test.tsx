import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  evaluateWorkflow,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import { WorkflowCapabilities } from "./WorkflowCapabilities";
let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const presence = {
  label: "Codex",
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  path: "/x/SKILL.md",
  scope: "project",
  enabled: true,
};
describe("workflow capability view", () => {
  it("keeps older remote snapshots unknown", async () => {
    await act(() => {
      renderer = create(<WorkflowCapabilities presence={presence} />);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Readiness unknown");
    expect(JSON.stringify(renderer.toJSON())).toContain("has not supplied dependency evidence");
  });
  it("shows evidence stages, exact scope and a dependency blocker", async () => {
    const workflow = evaluateWorkflow({
      scope: {
        environmentId: "remote-a",
        instanceId: "codex",
        workspaceRoot: "/work",
        sessionId: "session-a",
        providerThreadId: "native-a",
        nativeThreadId: "native-id-a",
        threadId: "thread-a",
      },
      declaration: { state: "declared", requires: { binaries: ["ffmpeg"] } },
      enabled: true,
      discoveredAt: "2026-10-28T04:00:00Z",
      now: Date.parse("2026-10-28T04:00:00Z"),
      binaries: new Map([["ffmpeg", "missing"]]),
      platform: "linux",
    });
    await act(() => {
      renderer = create(<WorkflowCapabilities presence={{ ...presence, workflow }} />);
    });
    const text = JSON.stringify(renderer.toJSON());
    for (const value of [
      "Cannot run here",
      "Configured",
      "Discovered",
      "Registered in session",
      "Last safe check",
      "remote-a",
      "session-a",
      "ffmpeg",
      "missing",
    ])
      expect(text).toContain(value);
    expect(text).toContain("does not prove instructions loaded");
  });
});
