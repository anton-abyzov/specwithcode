import { EnvironmentId } from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("env-desk");
const hosts = vi.hoisted(() => ({
  current: [] as Array<{ id: string; label: string; target: string }>,
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/device", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/device")>()),
  useDeviceState: () => ({ state: { hostStatuses: {}, hosts: [] } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./useHostConnectionChecks", () => ({
  useHostConnectionChecks: () => ({ checks: {}, testConnection: vi.fn() }),
}));
vi.mock("./DeviceHostEditor", () => ({ DeviceHostEditor: () => <form data-testid="editor" /> }));
vi.mock("../device/DeviceSetup", () => ({ DeviceHostDiagnostics: () => null }));
vi.mock("../device/DeviceToolVersions", () => ({ DeviceToolVersions: () => null }));
vi.mock("./SettingsScopeContext", () => {
  const environment = () => ({
    environmentId: "env-desk",
    label: "Desk",
    connection: { phase: "connected" },
    serverConfig: { settings: { deviceHosts: hosts.current } },
  });
  return {
    useSettingsScope: () => ({
      scope: { kind: "environment", environmentId: "env-desk", environmentIds: ["env-desk"] },
      search: { machine: "env-desk" },
      environments: [environment()],
      connectedEnvironments: [environment()],
      targets: [],
    }),
    useOptionalSettingsScope: () => null,
  };
});

import { DeviceHostsSettings } from "./DeviceHostsSettings";
import { SettingsRowsLockedContext } from "./settingsRowsLocked";

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  hosts.current = [];
});

async function mount() {
  await act(() => {
    renderer = create(<DeviceHostsSettings environmentId={environmentId} />);
  });
  return renderer!.root;
}

const toggle = (root: ReactTestRenderer["root"]) =>
  root.find(
    (node) => node.type === "button" && node.props["aria-controls"] === "device-hosts-list",
  );
function text(root: ReactTestRenderer["root"]): string {
  return root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child): child is string => typeof child === "string"))
    .join(" ");
}

describe("DeviceHostsSettings", () => {
  it("keeps the host list closed until asked, and counts what is in it", async () => {
    hosts.current = [
      { id: "a", label: "Loft", target: "loft.local" },
      { id: "b", label: "Lab", target: "lab.local" },
    ];
    const root = await mount();
    expect(toggle(root).props["aria-expanded"]).toBe(false);
    expect(text(root)).toContain("Device hosts: 2");
    expect(text(root)).not.toContain("Loft");
    expect(text(root)).not.toContain("Add host");
    // The row a search result or an old link names is there before the list opens.
    expect(root.findAll((node) => node.props.id === "device-hosts")).not.toEqual([]);

    await act(() => toggle(root).props.onClick());
    expect(toggle(root).props["aria-expanded"]).toBe(true);
    expect(text(root)).toContain("Loft");
    expect(text(root)).toContain("Add host");

    await act(() => toggle(root).props.onClick());
    expect(text(root)).not.toContain("Loft");
  });

  it("shows the list at once to a sign-in that may only look", async () => {
    hosts.current = [{ id: "a", label: "Loft", target: "loft.local" }];
    await act(() => {
      renderer = create(
        <SettingsRowsLockedContext.Provider value={true}>
          <DeviceHostsSettings environmentId={environmentId} />
        </SettingsRowsLockedContext.Provider>,
      );
    });
    const root = renderer!.root;
    expect(toggle(root).props["aria-expanded"]).toBe(true);
    expect(text(root)).toContain("Loft");
  });

  it("says so when the machine has no device host", async () => {
    const root = await mount();
    expect(text(root)).toContain("No device hosts.");
    expect(text(root)).not.toContain("Add host");
  });
});
