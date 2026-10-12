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
const catalog = (agents: readonly AcpRegistrySearchAgent[] = [copilot, grok]) => ({
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
    state.queries = [catalog(), catalog()];
  });

  it("resolves both exact registry IDs on the selected remote environment without installation", () => {
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
    ]);
    expect(onPrepare).not.toHaveBeenCalled();
  });

  it("passes current registry metadata unchanged only after an explicit Add", () => {
    const onPrepare = vi.fn();
    const tree = render({ onPrepare });
    expect(onPrepare).not.toHaveBeenCalled();
    (byLabel(tree, "Add GitHub Copilot").props.onClick as () => void)();
    expect(onPrepare).toHaveBeenCalledWith(copilot);
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

  it("blocks both actions while refreshing or preparing another provider", () => {
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
});
