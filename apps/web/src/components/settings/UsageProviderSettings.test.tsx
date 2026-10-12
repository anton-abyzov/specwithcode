// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, type LocalUsageHub } from "@specweave-studio/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  detect: vi.fn(),
  adopt: vi.fn(),
  update: vi.fn(),
  addDialogUrl: null as string | null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../hooks/useSettings", () => ({ useUpdateEnvironmentSettings: () => state.update }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    detectLocalUsageHubs: "detect",
    adoptLocalUsageHub: "adopt",
    updateSettings: "update",
    refreshProviders: "refresh",
    configValueAtom: () => "config",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "detect" ? state.detect : command === "adopt" ? state.adopt : vi.fn(),
}));
vi.mock("./AddUsageLimitSourceDialog", () => ({
  AddUsageLimitSourceDialog: ({ initialUrl }: { initialUrl?: string }) => {
    state.addDialogUrl = initialUrl ?? "";
    return <p>Add hub dialog</p>;
  },
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div data-row>
      <strong>{title}</strong>
      {description}
      {control}
    </div>
  ),
}));

import { UsageProviderSettings } from "./UsageProviderSettings";

const environmentId = EnvironmentId.make("host");
const hub = (over: Partial<LocalUsageHub> = {}): LocalUsageHub => ({
  id: "specweave",
  url: "http://127.0.0.1:8317",
  configPath: "/home/me/.local/share/specweave/proxy/config.yaml",
  running: true,
  keyAvailable: true,
  sourceId: null,
  ...over,
});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.detect.mockReset();
  state.adopt.mockReset();
  state.addDialogUrl = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(
  hubs: ReadonlyArray<LocalUsageHub>,
  props: { sources?: Record<string, unknown>; readOnly?: boolean } = {},
) {
  state.detect.mockResolvedValue({ _tag: "Success", value: { hubs } });
  await act(async () =>
    root.render(
      <UsageProviderSettings
        environmentId={environmentId}
        environmentLabel="Studio Mac"
        sources={(props.sources ?? {}) as never}
        cursorKeychainUsageEnabled={false}
        readOnly={props.readOnly ?? false}
      />,
    ),
  );
}
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

it("offers a detected hub and adds it without the browser handling a key", async () => {
  state.adopt.mockResolvedValue({
    _tag: "Success",
    value: { hubs: [hub({ sourceId: "cliproxy-127.0.0.1-8317" as never })] },
  });
  await render([hub()]);
  expect(container.textContent).toContain("CLI Proxy found on Studio Mac");
  expect(container.textContent).toContain("http://127.0.0.1:8317 · Running");
  expect(container.textContent).not.toContain("No hubs configured.");
  await act(async () => button("Add this hub")!.click());
  expect(state.adopt).toHaveBeenCalledWith({ environmentId, input: { id: "specweave" } });
  expect(state.update).not.toHaveBeenCalled();
});

it("opens the key dialog on the hub's address when the server cannot read its key", async () => {
  await render([hub({ id: "homebrew", keyAvailable: false, running: false })]);
  expect(container.textContent).toContain("Not running");
  expect(button("Add this hub")).toBeUndefined();
  await act(async () => button("Add with key")!.click());
  expect(state.addDialogUrl).toBe("http://127.0.0.1:8317");
});

it("does not offer a hub that is already a source, and marks it when it is stopped", async () => {
  await render([hub({ sourceId: "mine" as never, running: false })], {
    sources: { mine: { kind: "cliproxy", url: "http://localhost:8317", enabled: true } },
  });
  expect(container.textContent).not.toContain("CLI Proxy found on");
  expect(container.textContent).toContain("Not running");
});

it("never looks for hubs on a host the person cannot manage", async () => {
  await render([hub()], { readOnly: true });
  expect(state.detect).not.toHaveBeenCalled();
  expect(container.textContent).toContain("No hubs configured.");
});
