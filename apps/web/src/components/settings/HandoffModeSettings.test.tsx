import { DEFAULT_HANDOFF_CONFIG, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HandoffModeSettingsView } from "./HandoffModeSettings";

const render = (props: Partial<Parameters<typeof HandoffModeSettingsView>[0]>) =>
  renderToStaticMarkup(
    <HandoffModeSettingsView
      snapshot={{
        environmentId: EnvironmentId.make("env-m1"),
        machineLabel: "M1",
        config: DEFAULT_HANDOFF_CONFIG,
        projectModes: {},
        threads: [],
        incoming: [],
        pausedSince: null,
        machineRun: null,
      }}
      destinations={[]}
      pending={false}
      error={null}
      onConfig={() => {}}
      onProjectMode={() => {}}
      onHandOffMachine={() => {}}
      {...props}
    />,
  );

describe("Projects set differently", () => {
  it("lists only overridden projects, with a way back to the default", () => {
    const html = render({
      overrides: [
        { id: ProjectId.make("app"), title: "EasyChamp", mode: "on" },
        { id: ProjectId.make("old"), title: "Old app", archived: true, mode: "off" },
        { id: ProjectId.make("gone"), title: null, mode: "on" },
      ],
    });
    expect(html).toContain("EasyChamp: On");
    expect(html).toContain("Old app (archived): Off");
    expect(html).toContain("A removed project");
    expect(html).toContain('aria-label="Use the default for EasyChamp"');
    expect(html).not.toContain("Show automated");
    expect(html).not.toContain("Show archived");
  });

  it("shows no project list when nothing is overridden", () => {
    expect(render({})).not.toContain("Projects set differently");
  });
});

describe("Moving work between machines", () => {
  it("titles the section and orders its rows, with rare choices under More options", () => {
    const html = render({});
    expect(html).toContain("Moving work between machines");
    expect(html).toContain('id="handoff-mode"');
    expect(html).toContain('id="handoff-sleep-target"');
    const order = [
      "Keep threads ready to move",
      "When this Mac sleeps, move running threads to",
      "More options",
      "Turn summary",
      "Also back up syncs to the repository&#x27;s remote",
    ].map((text) => html.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("existing ones too");
    expect(html).toContain("Moves the threads that are ready to move.");
    expect(html).toContain("including uncommitted and untracked files");
    expect(html).toContain("Move running threads…");
    expect(html).not.toContain("Keep new threads");
    expect(html).not.toContain("Handoff");
    expect(html).not.toContain("Cheap model");
  });

  it("drops the automatic continue row, which nothing acts on yet", () => {
    expect(render({})).not.toContain("Continue automatically");
  });

  it("titles the sleep row without a placeholder when no machine is chosen", () => {
    const html = render({});
    expect(html).toContain("When this Mac sleeps, move running threads to</");
    expect(html).not.toContain("to …");
  });

  it("marks an offline sleep target", () => {
    const html = render({
      snapshot: {
        environmentId: EnvironmentId.make("env-m1"),
        machineLabel: "M1",
        config: { ...DEFAULT_HANDOFF_CONFIG, sleepTarget: EnvironmentId.make("env-m3") },
        projectModes: {},
        threads: [],
        incoming: [],
        pausedSince: null,
        machineRun: null,
      },
      destinations: [
        {
          environmentId: EnvironmentId.make("env-m3"),
          label: "M3",
          state: "offline",
          reason: "Offline",
        },
      ],
    });
    expect(html).toContain("M3 (offline)");
  });
});
