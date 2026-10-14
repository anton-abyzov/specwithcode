import { expect, it } from "vite-plus/test";
import { fullAccessAcpProjectFolders } from "./projectEnvironment.ts";

const full = { runtimeMode: "full-access", interactionMode: "default" };
it("admits only the existing unrestricted ACP folder policy", () => {
  expect(fullAccessAcpProjectFolders(full)).toBe(true);
  expect(
    fullAccessAcpProjectFolders({
      ...full,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    }),
  ).toBe(true);
  for (const override of [
    { runtimeMode: "approval-required" },
    { runtimeMode: "auto" },
    { runtimeMode: "auto-accept-edits" },
    { interactionMode: "plan" },
    { approvalPolicy: "on-request" },
    { approvalPolicy: null },
    { sandboxPolicy: null },
    { sandboxPolicy: [] },
    { sandboxPolicy: { type: "readOnly" } },
    { sandboxPolicy: { type: "workspaceWrite" } },
    { sandboxPolicy: { type: "externalSandbox" } },
    { sandboxPolicy: { type: "unknown" } },
  ])
    expect(fullAccessAcpProjectFolders({ ...full, ...override })).toBe(false);
});
