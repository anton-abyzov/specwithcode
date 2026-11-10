// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, type ProjectSkillRow } from "@specweave-studio/contracts";
import type { SkillControls } from "../settings/ProjectSkillControls";

const push = vi.fn();
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => push }));
vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: { skillFleetPush: {} } }));
vi.mock("./SkillAvailability", () => ({ refreshSkillAvailability: vi.fn() }));
import { SkillMachineInstall, machineInstallPlan } from "./SkillMachineInstall";

const base = {
  installed: "1.1.0",
  installedScope: "user" as const,
  latest: "1.3.0",
  scope: "user" as const,
  projectId: ProjectId.make("remote-project"),
  reachable: true,
  canPush: true,
};

describe("machine install plan", () => {
  it("offers an update when the same scope holds an older version", () => {
    expect(machineInstallPlan(base)).toEqual({ kind: "update", version: "1.3.0", reason: null });
    expect(machineInstallPlan({ ...base, installed: "1.3.0" }).kind).toBe("current");
  });
  it("installs into a scope that has no copy yet", () => {
    expect(machineInstallPlan({ ...base, scope: "project" }).kind).toBe("install");
    expect(machineInstallPlan({ ...base, installed: null }).kind).toBe("install");
  });
  it("explains why it cannot run", () => {
    expect(machineInstallPlan({ ...base, scope: "project", projectId: null }).reason).toContain(
      "not added on that machine",
    );
    expect(machineInstallPlan({ ...base, reachable: false }).reason).toBe(
      "This machine is offline.",
    );
    expect(machineInstallPlan({ ...base, canPush: false }).reason).toContain("permission");
    expect(machineInstallPlan({ ...base, latest: null }).reason).toContain("No registry version");
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
const button = (text: string) => {
  const found = [...host.querySelectorAll("button")].find((node) =>
    node.textContent?.startsWith(text),
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};

describe("one machine install", () => {
  it("previews, then confirms exactly the previewed target on that machine", async () => {
    push
      .mockResolvedValueOnce({
        _tag: "Success",
        value: {
          preview: true,
          results: [{ machineId: "m1", ok: true, preview: true, expectedHash: "hash" }],
        },
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { results: [{ machineId: "m1", ok: true, installedVersion: "1.3.0" }] },
      });
    const controls = {
      environmentId: "local",
      projectId: "local-project",
      canPush: true,
      row: { lock: { skillId: "owner/repo/obsidian-brain" } },
      versions: { data: { versions: [{ version: "1.3.0" }], outdated: null } },
    } as unknown as SkillControls;
    const row = { lock: { lockScope: "user", version: "1.1.0" } } as unknown as ProjectSkillRow;
    await act(async () =>
      root.render(
        <SkillMachineInstall
          controls={controls}
          machineId="m1"
          label="M1"
          row={row}
          projectId={null}
          reachable
        />,
      ),
    );
    expect(host.querySelector<HTMLInputElement>('input[type="radio"]:disabled')).not.toBeNull();
    await act(async () => button("Update to v1.3.0").click());
    expect(push.mock.calls[0]?.[0].input).toMatchObject({
      skillId: "owner/repo/obsidian-brain",
      version: "1.3.0",
      pin: false,
      preview: true,
      targets: [{ machineId: "m1", scope: "user" }],
    });
    await act(async () => button("Confirm").click());
    expect(push.mock.calls[1]?.[0].input).toMatchObject({
      preview: false,
      targets: [{ machineId: "m1", scope: "user", expectedHash: "hash" }],
    });
    expect(host.textContent).toContain("Installing v1.3.0 on M1");
  });
});
