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
      "Away target",
      "When this machine wakes",
      "More options",
      "Turn summary",
      "Also back up syncs to the repository&#x27;s remote",
    ].map((text) => html.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("existing ones too");
    expect(html).toContain(
      "Where Away sends your threads, routines and coordinators when you leave this machine. Closing the lid moves nothing.",
    );
    expect(html).toContain("including uncommitted and untracked files");
    expect(html).toContain("Move running threads…");
    expect(html).not.toContain("Keep new threads");
    expect(html).not.toContain("Handoff");
    expect(html).not.toContain("Cheap model");
  });

  it("titles the sleep row without a placeholder when no machine is chosen", () => {
    const html = render({});
    expect(html).toContain("Away target</");
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

describe("sleep and silence start nothing (1390 AC-36)", () => {
  // Class names hold "disabled:" variants; only attributes count here.
  const withSnapshot = (
    config: Partial<typeof DEFAULT_HANDOFF_CONFIG>,
    pendingDisarm?: ReadonlyArray<{
      environmentId: EnvironmentId;
      machineLabel: string;
      since: string;
    }>,
  ) =>
    render({
      snapshot: {
        environmentId: EnvironmentId.make("env-m1"),
        machineLabel: "M1",
        config: { ...DEFAULT_HANDOFF_CONFIG, ...config },
        projectModes: {},
        threads: [],
        incoming: [],
        pausedSince: null,
        machineRun: null,
        ...(pendingDisarm === undefined ? {} : { pendingDisarm }),
      },
    }).replace(/ class="[^"]*"/g, "");

  it("offers no lid-close or silence start, whatever an earlier version saved", () => {
    const html = withSnapshot({
      sleepTarget: EnvironmentId.make("env-ms"),
      sleepTrigger: "always",
      graceMinutes: 10,
      autoTakeoverMinutes: 15,
      bringBack: "auto-on-power",
    });
    expect(html).not.toContain("Leave automatically when the lid closes");
    expect(html).not.toContain("Grace time");
    expect(html).not.toContain("Continue automatically when a machine stops answering");
    expect(html).not.toContain("Automatic takeover");
    expect(html).not.toContain('id="away-sleep-trigger"');
    expect(html).not.toContain("Also used when this machine sleeps");
    // Bringing work back after a wake is not a start: that choice stays.
    expect(html).toMatch(
      /aria-label="When this machine wakes"[^>]*>[\s\S]*?Bring back automatically on power/,
    );
    expect(html).toContain("After you left with Away. Ask shows one button to bring it back.");
    expect(html).not.toContain("\u2014");
  });

  it("names each machine that has not confirmed yet, and nothing when all have", () => {
    expect(withSnapshot({})).not.toContain("to confirm that silence no longer moves threads");
    expect(withSnapshot({}, [])).not.toContain("to confirm that silence no longer moves threads");
    const html = withSnapshot({}, [
      {
        environmentId: EnvironmentId.make("env-m3"),
        machineLabel: "M3",
        since: "2026-11-19T10:00:00.000Z",
      },
      {
        environmentId: EnvironmentId.make("env-m5"),
        machineLabel: "M5",
        since: "2026-11-19T10:00:00.000Z",
      },
    ]);
    for (const machine of ["M3", "M5"]) {
      expect(html).toContain(
        `Waiting for ${machine} to confirm that silence no longer moves threads. Until it answers, a thread it could continue pauses here when it goes quiet.`,
      );
    }
    expect(html).toContain('role="status"');
  });
});
