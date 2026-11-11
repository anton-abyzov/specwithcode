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
    expect(machineInstallPlan({ ...base, latest: null }).reason).toContain("registry version");
    expect(machineInstallPlan({ ...base, latest: "1.4.0-beta.1" }).reason).toContain(
      "registry version",
    );
    expect(machineInstallPlan({ ...base, blocked: "Checking this machine…" }).reason).toBe(
      "Checking this machine…",
    );
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
    expect(host.textContent).toContain("Installed v1.3.0 on M1");
  });
  it("asks for a pin choice where the pin is unknown and refreshes after a failed confirm", async () => {
    const { refreshSkillAvailability } = await import("./SkillAvailability");
    push
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { preview: true, results: [{ machineId: "m4", ok: true, expectedHash: "h" }] },
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { results: [{ machineId: "m4", ok: false, reason: "outcome_unknown" }] },
      });
    const controls = {
      environmentId: "local",
      projectId: "local-project",
      canPush: true,
      row: { lock: { skillId: "owner/repo/obsidian-brain", lockScope: "project" } },
      versions: { data: { versions: [{ version: "1.3.0" }], outdated: null } },
    } as unknown as SkillControls;
    // The row reports the project copy, pinned; the user scope's pin is not visible.
    const projectRow = {
      lock: { lockScope: "project", version: "1.1.0", pinnedVersion: "1.1.0" },
    } as unknown as ProjectSkillRow;
    await act(async () =>
      root.render(
        <SkillMachineInstall
          controls={controls}
          machineId="m4"
          label="M4"
          row={projectRow}
          projectId={ProjectId.make("m4-project")}
          reachable
        />,
      ),
    );
    const radio = (text: string) =>
      [...host.querySelectorAll("label")]
        .find((node) => node.textContent?.startsWith(text))
        ?.querySelector("input") as HTMLInputElement;
    expect(radio("Keep pinned").checked).toBe(true);
    await act(async () => radio("User, all projects").click());
    expect(host.textContent).toContain("Choose whether to pin");
    expect(button("Install v1.3.0").disabled).toBe(true);
    await act(async () => radio("Don't pin").click());
    await act(async () => button("Install v1.3.0").click());
    expect(push.mock.calls[0]?.[0].input).toMatchObject({
      pin: false,
      targets: [{ machineId: "m4", scope: "user" }],
    });
    expect(host.textContent).toContain("replaces any pin there");
    await act(async () => button("Confirm").click());
    expect(refreshSkillAvailability).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("asks for a pin choice for a project install beside a user-lock row or from a user-level view", async () => {
    const controls = (userLevel: boolean) =>
      ({
        environmentId: "local",
        projectId: "local-project",
        canPush: true,
        userLevel,
        row: { lock: { skillId: "owner/repo/obsidian-brain", lockScope: "user" } },
        versions: { data: { versions: [{ version: "1.3.0" }], outdated: null } },
      }) as unknown as SkillControls;
    const userRow = { lock: { lockScope: "user", version: "1.1.0" } } as unknown as ProjectSkillRow;
    const radio = (text: string) =>
      [...host.querySelectorAll("label")]
        .find((node) => node.textContent?.startsWith(text))
        ?.querySelector("input") as HTMLInputElement;
    for (const [key, userLevel, row] of [
      ["user-row", false, userRow],
      ["user-level", true, null],
    ] as const) {
      await act(async () =>
        root.render(
          <SkillMachineInstall
            key={key}
            controls={controls(userLevel)}
            machineId="m6"
            label="M6"
            row={row}
            projectId={ProjectId.make("m6-project")}
            reachable
          />,
        ),
      );
      await act(async () => radio("This project only").click());
      expect(host.textContent).toContain("Choose whether to pin");
      expect(button("Install v1.3.0").disabled).toBe(true);
    }
  });
  it("requires a pin choice on a machine that was not read", async () => {
    const controls = {
      environmentId: "local",
      projectId: "local-project",
      canPush: true,
      row: { lock: { skillId: "owner/repo/obsidian-brain", lockScope: "user" } },
      versions: { data: { versions: [{ version: "1.3.0" }], outdated: null } },
    } as unknown as SkillControls;
    await act(async () =>
      root.render(
        <SkillMachineInstall
          controls={controls}
          machineId="m5"
          label="M5"
          row={null}
          projectId={null}
          reachable
          unread
        />,
      ),
    );
    expect(button("Install v1.3.0").disabled).toBe(true);
    expect(host.textContent).toContain("Choose whether to pin");
  });
  it("keeps a remote pin and follows a user-level skill's scope by default", async () => {
    push.mockResolvedValueOnce({
      _tag: "Success",
      value: { results: [{ machineId: "m2", ok: false, reason: "outcome_unknown" }] },
    });
    const { refreshSkillAvailability } = await import("./SkillAvailability");
    const controls = {
      environmentId: "local",
      projectId: "local-project",
      canPush: true,
      row: { lock: { skillId: "owner/repo/obsidian-brain", lockScope: "user" } },
      versions: { data: { versions: [{ version: "1.3.0" }], outdated: { latest: "9.9.9" } } },
    } as unknown as SkillControls;
    const pinnedRow = {
      lock: { lockScope: "project", version: "1.1.0", pinnedVersion: "1.1.0" },
    } as unknown as ProjectSkillRow;
    await act(async () =>
      root.render(
        <SkillMachineInstall
          controls={controls}
          machineId="m2"
          label="M2"
          row={pinnedRow}
          projectId={ProjectId.make("m2-project")}
          reachable
        />,
      ),
    );
    await act(async () => button("Update to v1.3.0").click());
    expect(push.mock.calls[0]?.[0].input).toMatchObject({
      version: "1.3.0",
      pin: true,
      targets: [{ machineId: "m2", scope: "project", projectId: "m2-project" }],
    });
    expect(refreshSkillAvailability).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <SkillMachineInstall
          key="fresh"
          controls={controls}
          machineId="m3"
          label="M3"
          row={null}
          projectId={ProjectId.make("m3-project")}
          reachable
        />,
      ),
    );
    const checked = host.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    expect(checked?.parentElement?.textContent).toContain("User, all projects on M3");
  });
});
