// @vitest-environment jsdom
import {
  type AgentSearch,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  canSearch: true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: "refresh" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.canSearch }));
vi.mock("../../i18n", () => ({
  useTx:
    () =>
    (english: string, values: Readonly<Record<string, unknown>> = {}) =>
      english.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name])),
}));

import {
  defaultAgentInstance,
  FoundAgents,
  FoundAgentsList,
  foundAgentsView,
  isAgentInUse,
} from "./FoundAgents";

const environmentId = EnvironmentId.make("environment-1");
const driver = ProviderDriverKind.make;

const found = (
  agent: string,
  agentState: AgentSearch["agents"][number]["state"],
  kind: "builtIn" | "registry" = "builtIn",
) => ({ agent, kind, command: agent, state: agentState });

/** Pi signed in and off, Grok on, Muse and Gemini installed, Copilot added, Cursor silent. */
const SEARCH: AgentSearch = {
  agents: [
    found("codex", "not-installed"),
    found("cursor", "unknown"),
    found("grok", "ready"),
    found("muse", "installed"),
    found("opencode", "signed-out"),
    found("pi", "ready"),
    found("gemini", "installed", "registry"),
    found("github-copilot-cli", "installed", "registry"),
  ],
  pending: [],
  searched: ["/opt/tools/bin", "/usr/bin"],
  checkedAt: "2026-11-12T16:00:00.000Z",
};

const SETTINGS: Pick<ServerSettings, "providers" | "providerInstances"> = {
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: true },
  },
  providerInstances: {
    [ProviderInstanceId.make("copilot-1")]: {
      driver: driver("acpRegistry"),
      enabled: false,
      config: { agentId: "github-copilot-cli" },
    },
  },
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.refresh.mockReset();
  state.canSearch = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const rowOf = (name: string) =>
  [...container.querySelectorAll("li")].find((row) => row.textContent?.startsWith(name));

it("lists found agents that still need a step, and counts the rest", () => {
  const view = foundAgentsView(SEARCH, SETTINGS);
  expect(view.rows.map(({ name, state: rowState, kind }) => [name, rowState, kind])).toEqual([
    ["Muse Code", "installed", "builtIn"],
    ["OpenCode", "signed-out", "builtIn"],
    ["Pi", "ready", "builtIn"],
    ["Gemini CLI", "installed", "registry"],
  ]);
  expect(view.rows.find(({ agent }) => agent === "muse")?.sharesCode).toBe(true);
  expect(view.rows.find(({ agent }) => agent === "pi")?.sharesCode).toBe(false);
  expect(view.foundCount).toBe(6);
  expect(view.checkedCount).toBe(8);
  expect(view.notFound).toEqual(["Codex"]);
  expect(view.noAnswer).toEqual(["Cursor"]);
});

it("counts an agent as in use when any of its entries is on, or a registry agent is added", () => {
  expect(isAgentInUse(SETTINGS, found("grok", "ready"))).toBe(true);
  expect(isAgentInUse(SETTINGS, found("pi", "ready"))).toBe(false);
  // Added counts for a registry agent even while its entry is off.
  expect(isAgentInUse(SETTINGS, found("github-copilot-cli", "installed", "registry"))).toBe(true);
  expect(isAgentInUse(SETTINGS, found("gemini", "installed", "registry"))).toBe(false);
  const second = {
    ...SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("pi-work")]: { driver: driver("pi"), enabled: true, config: {} },
    },
  };
  expect(isAgentInUse(second, found("pi", "ready"))).toBe(true);
});

it("builds the default entry from the saved one, the older settings, or nothing", () => {
  const saved = { driver: driver("pi"), enabled: true, config: { binaryPath: "/opt/pi" } };
  expect(
    defaultAgentInstance(
      { ...SETTINGS, providerInstances: { [ProviderInstanceId.make("pi")]: saved } },
      driver("pi"),
    ),
  ).toBe(saved);
  const older = defaultAgentInstance(SETTINGS, driver("grok"));
  expect(older.driver).toBe("grok");
  expect(older.enabled).toBe(true);
  expect(older.config).not.toHaveProperty("enabled");
  // Muse Code has no older settings: its entry starts off and empty.
  expect(defaultAgentInstance(SETTINGS, driver("muse"))).toEqual({
    driver: "muse",
    enabled: false,
    config: {},
  });
});

const list = (
  overrides: Partial<Parameters<typeof FoundAgentsList>[0]> = {},
  search: AgentSearch = SEARCH,
) => (
  <FoundAgentsList
    view={foundAgentsView(search, SETTINGS)}
    searched={search.searched}
    searching={false}
    machine="Mac mini"
    readOnly={false}
    onFind={() => {}}
    onTurnOn={() => {}}
    onAdd={() => {}}
    {...overrides}
  />
);

it("shows each found agent with its state and one button", async () => {
  const onTurnOn = vi.fn();
  const onAdd = vi.fn();
  await act(async () => root.render(list({ onTurnOn, onAdd })));

  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "6 of 8 agents found on Mac mini.",
  );
  expect(rowOf("Pi")?.textContent).toContain("Signed in, not turned on.");
  expect(rowOf("OpenCode")?.textContent).toContain("Installed, not signed in.");
  expect(rowOf("Gemini CLI")?.textContent).toContain("Installed, not added.");
  expect(rowOf("Muse Code")?.textContent).toContain("Contributor mode");
  expect(rowOf("Pi")?.textContent).not.toContain("Contributor mode");
  for (const row of container.querySelectorAll("li:not(details li)")) {
    expect(row.querySelectorAll("button")).toHaveLength(1);
  }

  // Each button names its agent for a screen reader.
  expect(rowOf("Pi")?.querySelector("button")?.getAttribute("aria-label")).toBe("Turn on Pi");
  expect(rowOf("Gemini CLI")?.querySelector("button")?.getAttribute("aria-label")).toBe(
    "Add Gemini CLI",
  );

  await act(async () => rowOf("Pi")?.querySelector("button")?.click());
  expect(onTurnOn).toHaveBeenCalledWith("pi");
  await act(async () => rowOf("Gemini CLI")?.querySelector("button")?.click());
  expect(onAdd).toHaveBeenCalledOnce();

  // What was not found, and where the search looked.
  const details = container.querySelector("details");
  expect(details?.querySelector("summary")?.textContent).toBe(
    "Not found: Codex. No answer from: Cursor.",
  );
  expect([...(details?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual([
    "/opt/tools/bin",
    "/usr/bin",
  ]);
});

it("says what it is still looking for, and offers no second search meanwhile", async () => {
  const searching: AgentSearch = {
    ...SEARCH,
    pending: ["cursor", "grok", "muse", "opencode", "pi"],
  };
  await act(async () => root.render(list({ searching: true }, searching)));
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Looking for Cursor, Grok, Muse Code and 2 more…",
  );
  expect(button("Find agents")?.disabled).toBe(true);
});

it("offers no button to a window that may not change settings", async () => {
  await act(async () => root.render(list({ readOnly: true })));
  expect(rowOf("Pi")).toBeDefined();
  expect(button("Turn on")).toBeUndefined();
  expect(button("Add agent")).toBeUndefined();
  expect(button("Find agents")).toBeDefined();
});

const reply = (agentSearch?: AgentSearch) => ({
  _tag: "Success" as const,
  value: { providers: [], ...(agentSearch === undefined ? {} : { agentSearch }) },
});

const mount = () =>
  act(async () =>
    root.render(
      <FoundAgents
        environmentId={environmentId}
        machine="Mac mini"
        settings={SETTINGS}
        readOnly={false}
        onTurnOn={() => {}}
        onAdd={() => {}}
      />,
    ),
  );

it("searches when the page opens and reads progress until every agent answered", async () => {
  vi.useFakeTimers();
  state.refresh
    .mockResolvedValueOnce(reply({ ...SEARCH, agents: [], pending: ["pi", "grok"] }))
    .mockResolvedValueOnce(reply({ ...SEARCH, agents: [found("pi", "ready")], pending: ["grok"] }))
    .mockResolvedValueOnce(reply(SEARCH));

  await mount();
  expect(state.refresh).toHaveBeenCalledWith({ environmentId, input: { discover: true } });
  expect(text()).toContain("Looking for Pi, Grok…");
  expect(rowOf("Pi")).toBeUndefined();

  // Rows appear as agents answer, before the search is done.
  await act(async () => vi.advanceTimersByTimeAsync(700));
  expect(rowOf("Pi")).toBeDefined();
  expect(text()).toContain("Looking for Grok…");

  await act(async () => vi.advanceTimersByTimeAsync(700));
  expect(text()).toContain("6 of 8 agents found on Mac mini.");
  expect(state.refresh).toHaveBeenCalledTimes(3);

  // Done: nothing is asked again until the person asks.
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(state.refresh).toHaveBeenCalledTimes(3);
});

it("stops reading progress when the page closes", async () => {
  vi.useFakeTimers();
  state.refresh.mockResolvedValue(reply({ ...SEARCH, agents: [], pending: ["pi"] }));
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(700));
  expect(state.refresh).toHaveBeenCalledTimes(2);

  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(state.refresh).toHaveBeenCalledTimes(2);
});

it("gives up on a search that reports no end, and offers Find agents again", async () => {
  vi.useFakeTimers();
  state.refresh.mockResolvedValue(reply({ ...SEARCH, agents: [], pending: ["pi"] }));
  await mount();
  expect(button("Find agents")?.disabled).toBe(true);

  await act(async () => vi.advanceTimersByTimeAsync(95_000));
  const asked = state.refresh.mock.calls.length;
  expect(button("Find agents")?.disabled).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(state.refresh).toHaveBeenCalledTimes(asked);
});

it("starts a fresh search from Find agents", async () => {
  state.refresh.mockResolvedValue(reply(SEARCH));
  await mount();
  await act(async () => button("Find agents")?.click());
  expect(state.refresh).toHaveBeenLastCalledWith({
    environmentId,
    input: { discover: true, fresh: true },
  });
});

it("shows nothing for a machine whose server cannot search, and asks it once", async () => {
  vi.useFakeTimers();
  state.refresh.mockResolvedValue(reply());
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(container.innerHTML).toBe("");
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("does not search from a window that may not read the machine's agents", async () => {
  state.canSearch = false;
  await mount();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(container.innerHTML).toBe("");
});
