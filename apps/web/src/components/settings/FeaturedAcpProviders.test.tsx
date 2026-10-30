import type { ReactElement } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  type AcpRegistrySearchAgent,
} from "@specweave-studio/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({ search: vi.fn(), queries: [] as unknown[] }));
vi.mock("../../state/server", () => ({ serverEnvironment: { searchAcpRegistry: state.search } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state.queries.shift() }));

import { FeaturedAcpProviders, FeaturedAcpProviderCards } from "./FeaturedAcpProviders";

const agent = (id: string): AcpRegistrySearchAgent => ({
  id,
  name: id,
  version: "9.8.7",
  description: "Official CLI",
  authors: [],
  license: null,
  website: null,
  repository: null,
  icon: null,
  distribution: "npx",
  integrity: "registry",
});
const copilot = agent("github-copilot-cli");
const grok = agent("grok-build");
const gemini = agent("gemini");
const catalog = (agents: readonly AcpRegistrySearchAgent[] = [copilot, grok, gemini]) => ({
  data: { agents },
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
});
function render(overrides: Partial<Parameters<typeof FeaturedAcpProviderCards>[0]> = {}) {
  return FeaturedAcpProviderCards({
    providerInstances: {},
    canManageProviders: true,
    preparingId: null,
    onPrepare: vi.fn(),
    copilot: catalog(),
    grok: catalog(),
    gemini: catalog(),
    ...overrides,
  }) as ReactElement<Record<string, unknown>>;
}
function byLabel(tree: ReactElement<Record<string, unknown>>, label: string) {
  const found = visitElements(tree, (element) => element.props["aria-label"] === label);
  expect(found).not.toBeNull();
  return found!;
}

describe("FeaturedAcpProviders", () => {
  beforeEach(() => {
    state.search.mockReset();
    state.queries = [catalog(), catalog(), catalog()];
  });

  it("resolves all exact registry IDs on the selected remote environment without installation", () => {
    const environmentId = EnvironmentId.make("remote-worker");
    const onPrepare = vi.fn();
    FeaturedAcpProviders({
      environmentId,
      providerInstances: {},
      canManageProviders: true,
      preparingId: null,
      onPrepare,
    });
    expect(state.search.mock.calls).toEqual([
      [{ environmentId, input: { query: "github-copilot-cli" } }],
      [{ environmentId, input: { query: "grok-build" } }],
      [{ environmentId, input: { query: "gemini" } }],
    ]);
    expect(onPrepare).not.toHaveBeenCalled();
  });

  it("passes current registry metadata unchanged only after an explicit Add", () => {
    const onPrepare = vi.fn();
    const tree = render({ onPrepare });
    expect(onPrepare).not.toHaveBeenCalled();
    (byLabel(tree, "Add GitHub Copilot").props.onClick as () => void)();
    expect(onPrepare).toHaveBeenCalledWith(copilot);
    (byLabel(tree, "Add Gemini CLI").props.onClick as () => void)();
    expect(onPrepare).toHaveBeenLastCalledWith(gemini);
    expect(JSON.stringify(tree)).toContain("v9.8.7");
    expect(JSON.stringify(tree)).not.toMatch(/opus|4\.7|5\.5|unlimited/i);
  });

  it("rejects fuzzy matches and offers retry when the official identity is missing", () => {
    const missing = catalog([agent("unofficial-github-copilot-cli")]);
    const tree = render({ copilot: missing });
    expect(
      visitElements(tree, (element) => element.props["aria-label"] === "Add GitHub Copilot"),
    ).toBeNull();
    (byLabel(tree, "Retry GitHub Copilot registry lookup").props.onClick as () => void)();
    expect(missing.refresh).toHaveBeenCalledOnce();
  });

  it("does not use retained results after a registry failure", () => {
    const failed = { ...catalog(), error: "Network unavailable" };
    const tree = render({ copilot: failed });
    expect(
      visitElements(tree, (element) => element.props["aria-label"] === "Add GitHub Copilot"),
    ).toBeNull();
    expect(byLabel(tree, "Retry GitHub Copilot registry lookup").props.disabled).toBe(false);
  });

  it("blocks all actions while refreshing or preparing another provider", () => {
    const onPrepare = vi.fn();
    const pending = render({ copilot: { ...catalog(), isPending: true }, onPrepare });
    const pendingAdd = byLabel(pending, "Add GitHub Copilot");
    expect(pendingAdd.props.disabled).toBe(true);
    (pendingAdd.props.onClick as () => void)();
    const preparing = render({ preparingId: "grok-build", onPrepare });
    expect(byLabel(preparing, "Add GitHub Copilot").props.disabled).toBe(true);
    expect(byLabel(preparing, "Preparing Grok Build").props.disabled).toBe(true);
    expect(onPrepare).not.toHaveBeenCalled();
  });

  it("preserves read-only grants and configured registry instances", () => {
    const onPrepare = vi.fn();
    const readonly = render({ canManageProviders: false, onPrepare });
    const add = byLabel(readonly, "Add GitHub Copilot");
    expect(add.props.disabled).toBe(true);
    (add.props.onClick as () => void)();
    expect(onPrepare).not.toHaveBeenCalled();
    const configured = render({
      providerInstances: {
        copilot_work: {
          driver: ProviderDriverKind.make("acpRegistry"),
          config: { agentId: copilot.id },
        },
        grok: { driver: ProviderDriverKind.make("grok"), config: {} },
      },
    });
    expect(byLabel(configured, "Already added GitHub Copilot").props.disabled).toBe(true);
    expect(byLabel(configured, "Add Grok Build").props.disabled).toBe(false);
  });
  it("opens an existing instance even if the registry is unavailable, without preparing it", () => {
    const onManage = vi.fn();
    const onPrepare = vi.fn();
    const tree = render({
      providerInstances: {
        copilot_work: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: false,
          config: { agentId: copilot.id },
        },
      },
      copilot: { ...catalog(), error: "Offline" },
      canManageProviders: false,
      onManage,
      onPrepare,
    });
    const manage = byLabel(tree, "Manage GitHub Copilot");
    expect(manage.props.disabled).toBe(false);
    (manage.props.onClick as () => void)();
    expect(onManage).toHaveBeenCalledExactlyOnceWith("copilot_work");
    expect(onPrepare).not.toHaveBeenCalled();
    expect(JSON.stringify(tree)).toContain("Added · check setup");
  });

  it("keeps manage navigation blocked while another agent is being prepared", () => {
    const onManage = vi.fn();
    const tree = render({
      providerInstances: {
        gemini_work: {
          driver: ProviderDriverKind.make("acpRegistry"),
          config: { agentId: gemini.id },
        },
      },
      preparingId: copilot.id,
      onManage,
    });
    const manage = byLabel(tree, "Manage Gemini CLI");
    expect(manage.props.disabled).toBe(true);
    (manage.props.onClick as () => void)();
    expect(onManage).not.toHaveBeenCalled();
  });

  it("offers Grok Build only when the built-in Grok provider asks for it", () => {
    const hidden = render({ showGrok: false });
    expect(
      visitElements(hidden, (element) => element.props["aria-label"] === "Add Grok Build"),
    ).toBeNull();
    byLabel(hidden, "Add GitHub Copilot");
    byLabel(render(), "Add Grok Build");
  });
});
