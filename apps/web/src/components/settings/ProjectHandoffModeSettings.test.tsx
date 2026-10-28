import {
  DEFAULT_HANDOFF_CONFIG,
  EnvironmentId,
  type HandoffModeSnapshot,
  ProjectId,
} from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectHandoffModeSettingsView,
  projectHandoffDefaultText,
  projectHandoffValue,
  type ProjectHandoffMember,
} from "./ProjectHandoffModeSettings";

const snapshot = (
  environmentId: string,
  defaultMode: "on" | "off",
  projectModes: Record<string, "on" | "off"> = {},
): HandoffModeSnapshot => ({
  environmentId: EnvironmentId.make(environmentId),
  machineLabel: environmentId,
  config: { ...DEFAULT_HANDOFF_CONFIG, defaultMode },
  projectModes,
  threads: [],
  incoming: [],
  pausedSince: null,
  machineRun: null,
});

const member = (
  environmentId: string,
  id: string,
  value: HandoffModeSnapshot | null,
): ProjectHandoffMember => ({
  environmentId: EnvironmentId.make(environmentId),
  id: ProjectId.make(id),
  snapshot: value,
});

const label = (environmentId: string) => environmentId.toUpperCase();

describe("project ready-to-move value", () => {
  it("is Default when no copy overrides it", () => {
    expect(
      projectHandoffValue([member("m4", "a", snapshot("m4", "off")), member("m1", "b", null)]),
    ).toBe("default");
  });

  it("is the shared override, or Mixed when copies disagree", () => {
    const on = [
      member("m4", "a", snapshot("m4", "off", { a: "on" })),
      member("m1", "b", snapshot("m1", "off", { b: "on" })),
    ];
    expect(projectHandoffValue(on)).toBe("on");
    expect(projectHandoffValue([on[0]!, member("m1", "b", snapshot("m1", "off"))])).toBe("mixed");
  });

  it("says what Default means on each machine", () => {
    expect(projectHandoffDefaultText([member("m4", "a", snapshot("m4", "off"))], label)).toBe(
      "Off",
    );
    expect(
      projectHandoffDefaultText(
        [member("m4", "a", snapshot("m4", "on")), member("m1", "b", snapshot("m1", "off"))],
        label,
      ),
    ).toBe("On for M4");
  });
});

describe("ProjectHandoffModeSettingsView", () => {
  const render = (linked: boolean) =>
    renderToStaticMarkup(
      <ProjectHandoffModeSettingsView
        members={[member("m4", "a", snapshot("m4", "off"))]}
        linked={linked}
        label={label}
        pending={false}
        error={null}
        onChange={() => {}}
      />,
    );

  it("offers one choice for the whole project", () => {
    const html = render(true);
    expect(html).toContain("Keep this project&#x27;s threads ready to move");
    expect(html).toContain("Default follows each machine&#x27;s own setting (now off)");
  });

  it("explains an unlinked project has nowhere to sync to", () => {
    expect(render(false)).toContain("Link this project on another machine first.");
  });
});
