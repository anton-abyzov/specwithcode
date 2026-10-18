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
  navigate: vi.fn(),
  canManage: true,
  allowedOnClick: true,
  presentations: new Map(),
  pooledEnvironmentIds: [] as string[],
  machineEnvironmentIds: null as string[] | null,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "presentations" ? state.presentations : null),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.canManage,
  readEnvironmentScope: () => state.allowedOnClick,
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: "presentations" },
}));
vi.mock("../usage/UsageLimitsPooled", () => ({
  UsageLimitsPooled: ({ presentations }: { presentations: ReadonlyMap<string, unknown> }) => {
    state.pooledEnvironmentIds = [...presentations.keys()];
    return <p>Pooled quota reports</p>;
  },
}));
vi.mock("../studio/shell/HostLimits", () => ({
  MachineLimitBlocks: ({ only }: { only: ReadonlySet<string> | null }) => {
    state.machineEnvironmentIds = only === null ? null : [...only];
    return <p>Limits by machine</p>;
  },
}));
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
import { UsageLimitsSection } from "../usage/UsageLimits";
import { searchSettings } from "./settingsSearch";

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
  state.update.mockReset();
  state.navigate.mockReset();
  state.canManage = true;
  state.allowedOnClick = true;
  state.presentations = new Map();
  state.pooledEnvironmentIds = [];
  state.machineEnvironmentIds = null;
  localStorage.clear();
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
        environmentLabel="SpecWithCode Mac"
        sources={(props.sources ?? {}) as never}
        cursorKeychainUsageEnabled={false}
        readOnly={props.readOnly ?? false}
      />,
    ),
  );
}
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
/** Setup chips only: the by machine / by account toggle is always there. */
const setupButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Set up"));

it("offers a detected hub and adds it without the browser handling a key", async () => {
  state.adopt.mockResolvedValue({
    _tag: "Success",
    value: { hubs: [hub({ sourceId: "cliproxy-127.0.0.1-8317" as never })] },
  });
  await render([hub()]);
  expect(container.textContent).toContain("CLIProxyAPI found on SpecWithCode Mac");
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
  expect(container.textContent).not.toContain("CLIProxyAPI found on");
  expect(container.textContent).toContain("Not running");
});

it("never looks for hubs on a host the person cannot manage", async () => {
  await render([hub()], { readOnly: true });
  expect(state.detect).not.toHaveBeenCalled();
  expect(container.textContent).toContain("No hubs configured.");
});

it("separates a configured quota source from chat setup on the selected machine", async () => {
  await render([], {
    sources: { mine: { kind: "cliproxy", url: "http://localhost:8317", enabled: true } },
  });
  expect(container.textContent).toContain("Usage reporting only");
  expect(container.textContent).toContain(
    "Adding a hub does not connect its models to SpecWithCode chats.",
  );
  expect(container.textContent).toContain("CLIProxyAPI · Usage reporting");
  await act(async () => button("Set up chat providers")!.click());
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/settings/providers",
    search: { environmentId },
    hash: "providers",
  });
  expect(state.adopt).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
});

it("keeps the explanation without offering setup to a read-only session", async () => {
  await render([], { readOnly: true });
  expect(container.textContent).toContain("Usage reporting only");
  expect(button("Set up chat providers")).toBeUndefined();
});

it("requires the selected machine's provider-management grant for setup", async () => {
  state.canManage = false;
  await render([]);
  expect(button("Set up chat providers")).toBeUndefined();
});

it("rechecks the provider-management grant before opening setup", async () => {
  await render([]);
  state.allowedOnClick = false;
  await act(async () => button("Set up chat providers")!.click());
  expect(state.navigate).not.toHaveBeenCalled();
});

function usageEnvironment(label: string, phase = "connected", providers: unknown[] = []) {
  return { entry: { target: { label } }, connection: { phase }, serverConfig: { providers } };
}

const readyCodex = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "me@example.com" },
  checkedAt: "2026-10-15T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

it("offers setup only on machines without a ready chat provider", async () => {
  const freshId = EnvironmentId.make("fresh");
  state.presentations = new Map([
    [environmentId, usageEnvironment("M4 Mac", "connected", [readyCodex])],
    [freshId, usageEnvironment("Fresh Mac")],
  ]);
  await act(async () => root.render(<UsageLimitsSection selectedEnvironmentIds={null} now={0} />));
  expect(button("Set up on M4 Mac")).toBeUndefined();
  expect(button("Set up on Fresh Mac")).toBeDefined();
  expect(container.textContent).toContain("This machine has no ready, signed-in chat provider yet");
});

it("hides every setup chip when all machines are ready, keeping the caveat", async () => {
  state.presentations = new Map([
    [environmentId, usageEnvironment("M4 Mac", "connected", [readyCodex])],
    [EnvironmentId.make("m1"), usageEnvironment("M1 Mac", "connected", [readyCodex])],
  ]);
  await act(async () => root.render(<UsageLimitsSection selectedEnvironmentIds={null} now={0} />));
  expect(setupButton()).toBeUndefined();
  expect(container.textContent).toContain(
    "Quota reports do not confirm that an agent is ready to chat.",
  );
  expect(container.textContent).not.toContain("Set up");
});

it("routes usage-view setup to its selected machine without changing the quota filter", async () => {
  const remoteId = EnvironmentId.make("remote");
  state.presentations = new Map([
    [environmentId, usageEnvironment("Local Mac")],
    [remoteId, usageEnvironment("Remote Mac")],
  ]);
  await act(async () =>
    root.render(<UsageLimitsSection selectedEnvironmentIds={new Set([remoteId])} now={0} />),
  );
  expect(container.textContent).toContain(
    "Quota reports do not confirm that an agent is ready to chat.",
  );
  expect(button("Set up on Local Mac")).toBeUndefined();
  await act(async () => button("Set up on Remote Mac")!.click());
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/settings/providers",
    search: { environmentId: remoteId },
    hash: "providers",
  });
  expect(state.machineEnvironmentIds).toEqual([remoteId]);
  await act(async () => button("By account")!.click());
  expect(state.pooledEnvironmentIds).toEqual([remoteId]);
});

it("does not offer setup on disconnected machines or without provider-management access", async () => {
  state.presentations = new Map([[environmentId, usageEnvironment("Offline Mac", "disconnected")]]);
  await act(async () => root.render(<UsageLimitsSection selectedEnvironmentIds={null} now={0} />));
  expect(setupButton()).toBeUndefined();
  state.presentations = new Map([[environmentId, usageEnvironment("Read-only Mac")]]);
  state.canManage = false;
  await act(async () => root.render(<UsageLimitsSection selectedEnvironmentIds={null} now={0} />));
  expect(setupButton()).toBeUndefined();
  expect(container.textContent).toContain("Quota reports do not confirm");
});

it.each(["Copilot", "Gemini", "Grok"])("finds agent setup by provider name %s", (query) => {
  expect(searchSettings(query)[0]).toMatchObject({ id: "providers", to: "/settings/providers" });
});

it.each(["usage providers", "CLIProxyAPI", "usage reporting"])(
  "keeps quota settings discoverable under %s",
  (query) => {
    expect(searchSettings(query)[0]).toMatchObject({
      id: "usage-providers",
      title: "Usage reporting",
    });
  },
);
