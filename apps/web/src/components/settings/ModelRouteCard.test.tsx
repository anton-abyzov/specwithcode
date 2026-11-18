import {
  EnvironmentId,
  type ModelRoute,
  type ModelRoutes,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describeTrack } from "@specweave-studio/shared/modelTrackRules";
import { act, type ReactElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ providers: {}, providerInstances: {} }),
  usePersistEnvironmentProviderInstanceMutation: () => vi.fn(),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../teamRules/useTeamRules", async () => {
  const view = await import("../../teamRules/teamRulesView");
  return { useTeamRules: () => view.teamRulesFromSummary(undefined) };
});

import { SortableList } from "./ModelListParts";
import { ModelRoutePanel } from "./ModelRouteCard";

const env = EnvironmentId.make("fixture-machine");
const fresh = "2026-11-18T08:00:00.000Z";
const now = Date.parse(fresh);
const FABLE = "claude-fable-5-2";
const pid = ProviderInstanceId.make;

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: pid(id),
    driver: ProviderDriverKind.make(driver),
    displayName: over.displayName ?? id,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...over,
  };
}

const claude = provider("claudeAgent", "claudeAgent", [FABLE], {
  displayName: "Claude Code",
  auth: { status: "authenticated", label: "Claude Max" },
});
const cursor = provider("cursor", "cursor", [FABLE], { displayName: "Cursor" });
const copilot = provider("acpRegistry_copilot", "acpRegistry", ["claude-fable-5"], {
  displayName: "GitHub Copilot",
  iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
});
const openrouter = provider("openrouter", "opencode", [FABLE], {
  displayName: "OpenRouter",
  auth: { status: "authenticated", type: "apiKey" },
});
const providers = [claude, cursor, copilot, openrouter];

const empty: ModelRoute = { order: [], dropped: [], pinned: false, allowed: [] };

let renderer: ReactTestRenderer | null = null;
function render(node: ReactElement) {
  act(() => {
    renderer = create(node);
  });
  return renderer!;
}
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});
beforeEach(() => state.navigate.mockReset());

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const button = (root: ReactTestInstance, label: string) =>
  root.find((node) => node.type === "button" && node.props["aria-label"] === label);
const offers = (root: ReactTestInstance) =>
  root
    .findAll(
      (node) => typeof node.props["data-route-offer"] === "string" && typeof node.type === "string",
    )
    .map((node) => node.props["data-route-offer"] as string);

function panel(routes?: ModelRoutes) {
  const onSave = vi.fn();
  const row = describeTrack({ track: "complex", saved: [], providers, nowMs: now, routes }).find(
    (entry) => entry.model === FABLE,
  )!;
  const view = render(
    <ModelRoutePanel
      environmentId={env}
      row={row}
      providers={providers}
      nowMs={now}
      sourceName={(entry) => entry.displayName ?? entry.instanceId}
      onSave={onSave}
    />,
  );
  return { root: view.root, onSave };
}

describe("ModelRoutePanel", () => {
  it("lists where the model runs with what each source costs", () => {
    const { root } = panel();
    const route = text(root.find((node) => node.type === "ol"));
    expect(route).toContain("Claude Code");
    expect(route).toContain("Claude Max");
    expect(route).toContain("Cursor");
    expect(route).toContain("Credits");
    expect(route).not.toContain("OpenRouter");
  });

  it("reorders the model's sources", () => {
    const { root, onSave } = panel();
    act(() => root.findByType(SortableList).props.onMove(1, 0));
    expect(onSave).toHaveBeenCalledWith({ ...empty, order: ["cursor", "claudeAgent"] });
  });

  it("drops a source for this model only", () => {
    const { root, onSave } = panel();
    act(() => button(root, "Never run it on Cursor").props.onClick());
    expect(onSave).toHaveBeenCalledWith({ ...empty, dropped: ["cursor"] });
  });

  it("pins a source", () => {
    const { root, onSave } = panel();
    act(() => button(root, "Pin Cursor").props.onClick());
    expect(onSave).toHaveBeenCalledWith({
      ...empty,
      order: ["cursor", "claudeAgent"],
      pinned: true,
    });
  });

  it("shows a dropped source with Restore", () => {
    const { root, onSave } = panel({ [FABLE]: { ...empty, dropped: [pid("cursor")] } });
    act(() => button(root, "Restore Cursor").props.onClick());
    expect(onSave).toHaveBeenCalledWith(empty);
  });

  it("adds a per-token source that then asks before its first run", () => {
    const first = panel();
    act(() => button(first.root, "Add OpenRouter").props.onClick());
    expect(first.onSave).toHaveBeenCalledWith({
      ...empty,
      order: ["claudeAgent", "cursor", "openrouter"],
    });
    act(() => renderer?.unmount());
    const { root } = panel({
      [FABLE]: { ...empty, order: [pid("claudeAgent"), pid("cursor"), pid("openrouter")] },
    });
    expect(text(root.find((node) => node.type === "ol"))).toContain("Asks before first run");
  });

  it("goes back to the automatic order", () => {
    const { root, onSave } = panel({ [FABLE]: { ...empty, dropped: [pid("cursor")] } });
    act(() =>
      root
        .find((node) => node.type === "button" && text(node) === "Use the automatic order")
        .props.onClick(),
    );
    expect(onSave).toHaveBeenCalledWith(empty);
  });

  it("names every other source that offers the model, never Copilot for Fable 5.2", () => {
    const { root } = panel();
    expect(offers(root)).toEqual(["devin"]);
    act(() => button(root, "Open Providers: Devin").props.onClick());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: env },
    });
  });
});
