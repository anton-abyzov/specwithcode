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
      "Leave automatically when the lid closes",
      "Grace time",
      "When this machine wakes",
      "More options",
      "Turn summary",
      "Also back up syncs to the repository&#x27;s remote",
    ].map((text) => html.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("existing ones too");
    expect(html).toContain("Where Away leaves your threads, routines and coordinators.");
    expect(html).toContain("including uncommitted and untracked files");
    expect(html).toContain("Move running threads…");
    expect(html).not.toContain("Keep new threads");
    expect(html).not.toContain("Handoff");
    expect(html).not.toContain("Cheap model");
  });

  it("offers automatic continue under More options, off by default", () => {
    const html = render({});
    expect(html).toContain("Continue automatically when a machine stops answering");
    expect(html.indexOf("Continue automatically")).toBeGreaterThan(html.indexOf("More options"));
    expect(html).toMatch(/aria-label="Automatic takeover"[^>]*>[\s\S]*?Off/);
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

describe("Away on lid close (D-01, D-02)", () => {
  // Class names hold "disabled:" variants; only attributes count here.
  const withConfig = (config: Partial<typeof DEFAULT_HANDOFF_CONFIG>) =>
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
      },
    }).replace(/ class="[^"]*"/g, "");

  it("shows the defaults: On battery, 2 min, Ask; off until a target is set", () => {
    const html = withConfig({});
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Leave automatically when the lid closes"/,
    );
    expect(html).toMatch(
      /aria-label="Leave automatically when the lid closes"[^>]*>[\s\S]*?On battery/,
    );
    expect(html).toMatch(/aria-label="Grace time"[^>]*>[\s\S]*?2 min/);
    expect(html).toMatch(/aria-label="When this machine wakes"[^>]*>[\s\S]*?Ask/);
    expect(html).toContain('id="away-sleep-trigger"');
    expect(html).not.toContain("\u2014");
  });

  it("shows stored choices once a target is set", () => {
    const html = withConfig({
      sleepTarget: EnvironmentId.make("env-ms"),
      sleepTrigger: "always",
      graceMinutes: 10,
      bringBack: "auto-on-power",
    });
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Leave automatically when the lid closes"/,
    );
    expect(html).toMatch(
      /aria-label="Leave automatically when the lid closes"[^>]*>[\s\S]*?Always/,
    );
    expect(html).toMatch(/aria-label="Grace time"[^>]*>[\s\S]*?10 min/);
    expect(html).toMatch(
      /aria-label="When this machine wakes"[^>]*>[\s\S]*?Bring back automatically on power/,
    );
  });
});
