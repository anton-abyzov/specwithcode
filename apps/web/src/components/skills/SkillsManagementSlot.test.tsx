// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

const seen = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("./SkillUpdateCenter", () => ({
  SkillUpdateCenter: (props: Record<string, unknown>) => {
    seen.props = props;
    return <div data-testid="center" />;
  },
}));
import { SkillsManagementSlot } from "./SkillsManagementSlot";
import { skillLatestVersions } from "./SkillUpdate.logic";

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe("skills management slot", () => {
  it("renders search, repos and updates for the page's machine and level", async () => {
    const host = document.createElement("div");
    root = createRoot(host);
    const onChanged = () => {};
    await act(async () =>
      root!.render(
        <SkillsManagementSlot
          environmentId={EnvironmentId.make("desk")}
          projectId={ProjectId.make("p1")}
          userLevel
          machineName="Desk"
          snapshot={null}
          onChanged={onChanged}
          onOpen={() => {}}
        />,
      ),
    );
    expect(host.querySelector('[data-testid="center"]')).not.toBeNull();
    expect(seen.props).toEqual({
      environmentId: "desk",
      projectId: "p1",
      userLevel: true,
      onChanged,
    });
  });
});

describe("skill latest versions", () => {
  const status = (skill: string, state: string, version: string | null) =>
    ({
      skill,
      repo: "owner/repo",
      lockScope: "user",
      installed: { version: "1.0.0", commit: null, contentHash: null },
      latest: version === null ? null : { version, commit: null, contentHash: null },
      state,
    }) as never;

  it("names only a newer versioned copy in the source", () => {
    expect([
      ...skillLatestVersions([
        status("a", "update", "1.1.0"),
        status("b", "changed", "1.0.0"),
        status("c", "current", "1.0.0"),
        status("d", "update", null),
        status("e", "pinned", "2.0.0"),
      ]),
    ]).toEqual([["a", "1.1.0"]]);
  });
});
