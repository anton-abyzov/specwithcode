// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import type { ProjectSkillsSnapshot } from "@specweave-studio/contracts";
vi.mock("../../state/environments", () => ({ useEnvironment: vi.fn() }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("../../studio/fleet", () => ({ useStudioFleet: vi.fn() }));
vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: {} }));
vi.mock("../settings/ProjectSkillControls", () => ({ useSkillControls: vi.fn() }));
import { skillAvailabilityState } from "./SkillAvailability";
const snapshot = { rows: [], providers: [{ state: "ok" }] } as unknown as ProjectSkillsSnapshot;
const input = {
  connected: true,
  error: null,
  successful: true,
  pending: false,
  snapshot,
  name: "example-skill",
  skillId: null,
};
describe("skill availability evidence", () => {
  it("never treats offline, denied, pending or incomplete scans as absent", () => {
    expect(skillAvailabilityState({ ...input, connected: false }).state).toBe("offline");
    expect(skillAvailabilityState({ ...input, error: "needs_grant" }).state).toBe("denied");
    expect(skillAvailabilityState({ ...input, pending: true }).state).toBe("unknown");
    expect(
      skillAvailabilityState({
        ...input,
        snapshot: {
          ...snapshot,
          providers: [{ state: "cached" }],
        } as unknown as ProjectSkillsSnapshot,
      }).state,
    ).toBe("stale");
  });
  it("reports missing only from a successful supported scan", () => {
    expect(skillAvailabilityState(input).state).toBe("missing");
    expect(
      skillAvailabilityState({ ...input, snapshot: { ...snapshot, providers: [] } }).state,
    ).toBe("unknown");
  });
  it("matches registry identity instead of a colliding name", () => {
    const data = {
      ...snapshot,
      rows: [
        {
          name: "example-skill",
          lock: { skillId: "other" },
          providers: [{ fileVersion: "1.0.0" }],
        },
      ],
    } as unknown as ProjectSkillsSnapshot;
    expect(skillAvailabilityState({ ...input, skillId: "requested", snapshot: data }).state).toBe(
      "missing",
    );
    expect(skillAvailabilityState({ ...input, snapshot: data }).text).toBe("v1.0.0");
  });
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { FleetPushPanel } from "../settings/ProjectSkillFleetPush";
import { useSkillControls } from "../settings/ProjectSkillControls";
import { useStudioFleet } from "../../studio/fleet";
import { useAtomCommand } from "../../state/use-atom-command";
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../settings/ProjectSkillRowMenu", () => ({ openSkillLink: vi.fn() }));
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    checked,
    disabled,
    onCheckedChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
vi.mock("../ui/radio-group", () => ({
  RadioGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Radio: () => <input type="radio" />,
}));

describe("fleet installation confirmation", () => {
  it("previews exact identity and retries failures without reinstalling successes", async () => {
    const hash = "a".repeat(64);
    vi.mocked(useSkillControls).mockReturnValue({
      environmentId: "local",
      projectId: "project",
      row: {
        name: "example",
        providers: [],
        lock: { skillId: "example", version: "1.2.3", sha: hash },
      },
      versions: { data: null },
      memberProjects: [
        { environmentId: "east", id: "east-project" },
        { environmentId: "west", id: "west-project" },
      ],
      canPush: true,
    } as never);
    vi.mocked(useStudioFleet).mockReturnValue({
      snapshot: {
        machines: [
          { id: "east", environmentId: "east", label: "East", status: "reachable" },
          { id: "west", environmentId: "west", label: "West", status: "reachable" },
        ],
      },
      loading: false,
      failed: false,
    } as never);
    const run = vi.fn(
      async ({ input }: { input: { preview: boolean; targets: { machineId: string }[] } }) => ({
        _tag: "Success",
        value: input.preview
          ? {
              preview: true,
              results: input.targets.map((target) => ({
                machineId: target.machineId,
                ok: true,
                preview: true,
                expectedHash: `observed-${target.machineId}`,
              })),
            }
          : {
              results: input.targets.map((target) => ({
                machineId: target.machineId,
                ok: target.machineId === "east",
                installedVersion: target.machineId === "east" ? "1.2.3" : null,
                message: "Permission changed",
              })),
            },
      }),
    );
    vi.mocked(useAtomCommand).mockReturnValue(run as never);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const click = async (text: string) => {
      const button = [...host.querySelectorAll("button")].find((item) => item.textContent === text);
      expect(button).toBeTruthy();
      await act(async () => button!.click());
    };
    try {
      await act(async () => root.render(<FleetPushPanel />));
      await click("Select all reachable");
      expect(run).not.toHaveBeenCalled();
      await click("Preview installation");
      expect(run.mock.calls[0]?.[0].input).toMatchObject({
        preview: true,
        version: "1.2.3",
        contentHash: hash,
        pin: true,
        targets: [
          { machineId: "east", agents: ["codex"] },
          { machineId: "west", agents: ["codex"] },
        ],
      });
      expect(host.textContent).toContain("Confirm installation");
      await click("Confirm installation");
      expect(run.mock.calls[1]?.[0].input).toMatchObject({
        preview: false,
        targets: [
          { machineId: "east", expectedHash: "observed-east" },
          { machineId: "west", expectedHash: "observed-west" },
        ],
      });
      await click("Preview failed targets only");
      expect(run.mock.calls[2]?.[0].input.targets.map((target) => target.machineId)).toEqual([
        "west",
      ]);
      expect(host.textContent).toContain("installed 1.2.3");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
