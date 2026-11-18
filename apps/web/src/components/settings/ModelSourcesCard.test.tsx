import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { listedSources } from "@specweave-studio/shared/modelSources";
import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  persist: vi.fn(),
  navigate: vi.fn(),
  canManage: true,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ providers: {}, providerInstances: {} }),
  usePersistEnvironmentProviderInstanceMutation: () => state.persist,
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => state.canManage,
}));
vi.mock("../../teamRules/useTeamRules", async () => {
  const view = await import("../../teamRules/teamRulesView");
  return { useTeamRules: () => view.teamRulesFromSummary(undefined) };
});
// The list renders in place, so the test reads it without a browser portal.
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  PopoverPopup: ({ children }: { children: ReactNode }) => <div data-popup="">{children}</div>,
  PopoverTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { SortableList } from "./ModelListParts";
import { MissingTrackSource, SourcesCard } from "./ModelSourcesCard";

const env = EnvironmentId.make("fixture-machine");
const fresh = "2026-11-18T08:00:00.000Z";
const now = Date.parse(fresh);

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
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

const codex = provider("codex", "codex", ["gpt-6.1-sol"], { displayName: "Codex" });
const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"], {
  displayName: "Claude",
});
const copilot = provider("acpRegistry_copilot", "acpRegistry", ["gpt-6.1-sol"], {
  displayName: "GitHub Copilot",
  iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
});
const cursor = provider("cursor", "cursor", [], {
  displayName: "Cursor",
  status: "error",
  auth: { status: "unauthenticated" },
});
const muse = provider("muse", "muse", [], {
  displayName: "Muse Code",
  installed: false,
  status: "error",
});
const antigravity = provider("antigravity", "antigravity", [], {
  displayName: "Antigravity",
  enabled: false,
  installed: false,
  status: "disabled",
});

const sourceName = (entry: ServerProvider) => entry.displayName ?? entry.instanceId;

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
beforeEach(() => {
  state.persist.mockReset();
  state.persist.mockResolvedValue({ _tag: "Success" });
  state.navigate.mockReset();
  state.canManage = true;
});

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const byLabel = (root: ReactTestInstance, label: string) =>
  root.find((node) => node.type === "button" && node.props["aria-label"] === label);
const candidate = (root: ReactTestInstance, id: string) =>
  root.find((node) => node.props["data-source-candidate"] === id);

function sources(order: ReadonlyArray<string>, providers: ReadonlyArray<ServerProvider>) {
  const onSave = vi.fn();
  const saved = order.map((id) => ProviderInstanceId.make(id));
  const view = render(
    <SourcesCard
      environmentId={env}
      rows={listedSources({ providers, order: saved, nowMs: now })}
      providers={providers}
      order={saved}
      nowMs={now}
      sourceName={sourceName}
      configuredAgents={new Set(["github-copilot-cli"])}
      onSave={onSave}
    />,
  );
  return { root: view.root, onSave };
}

describe("SourcesCard", () => {
  const all = [codex, claude, copilot, cursor, muse, antigravity];

  it("adds a ready source after the listed ones", () => {
    const { root, onSave } = sources(["codex", "claudeAgent"], all);
    act(() => byLabel(root, "Add GitHub Copilot").props.onClick());
    expect(onSave).toHaveBeenCalledWith(["codex", "claudeAgent", "acpRegistry_copilot"]);
  });

  it("removes a source from the order only", () => {
    const { root, onSave } = sources(["codex", "claudeAgent", "acpRegistry_copilot"], all);
    act(() => byLabel(root, "Remove GitHub Copilot").props.onClick());
    expect(onSave).toHaveBeenCalledWith(["codex", "claudeAgent"]);
    expect(state.persist).not.toHaveBeenCalled();
  });

  it("refuses to remove the last source and says why", () => {
    const { root, onSave } = sources(["codex"], all);
    act(() => byLabel(root, "Remove Codex").props.onClick());
    expect(onSave).not.toHaveBeenCalled();
    expect(text(root.find((node) => node.props.role === "alert"))).toContain(
      "Keep at least one source",
    );
  });

  it("reorders with the existing validation", () => {
    const { root, onSave } = sources(["codex", "claudeAgent"], all);
    act(() => root.findByType(SortableList).props.onMove(1, 0));
    expect(onSave).toHaveBeenCalledWith(["claudeAgent", "codex"]);
  });

  it("lists sources to add with their real state, ready first, each with its fix", () => {
    const { root } = sources(["codex", "claudeAgent"], all);
    const listed = root
      .findAll((node) => typeof node.props["data-source-candidate"] === "string")
      .map((node) => [node.props["data-source-candidate"], node.props["data-source-state"]]);
    expect(listed).toEqual([
      ["acpRegistry_copilot", "ready"],
      ["cursor", "sign-in"],
      ["muse", "not-installed"],
      ["antigravity", "off"],
      // Registry agents with no entry here are set up in Providers.
      ["grok-build", "not-set-up"],
      ["gemini", "not-set-up"],
    ]);
    expect(text(candidate(root, "cursor"))).toContain("Sign in");
    expect(text(candidate(root, "muse"))).toContain("Install");
    expect(text(candidate(root, "antigravity"))).toContain("Turn on");
    expect(text(candidate(root, "gemini"))).toContain("Open Providers");
  });

  it("offers GitHub Copilot on a machine that has no Copilot entry", () => {
    const onSave = vi.fn();
    const view = render(
      <SourcesCard
        environmentId={env}
        rows={listedSources({ providers: [codex, claude], nowMs: now })}
        providers={[codex, claude]}
        order={[]}
        nowMs={now}
        sourceName={sourceName}
        configuredAgents={new Set()}
        onSave={onSave}
      />,
    );
    act(() => byLabel(view.root, "Open Providers: GitHub Copilot").props.onClick());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: env },
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("turns an off source on in place and adds it", () => {
    const { root, onSave } = sources(["codex", "claudeAgent"], all);
    act(() => byLabel(root, "Turn on: Antigravity").props.onClick());
    expect(onSave).toHaveBeenCalledWith(["codex", "claudeAgent", "antigravity"]);
    expect(state.persist).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: "antigravity",
        instance: { driver: "antigravity", enabled: true, config: {} },
      },
      expect.any(Object),
    );
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("opens the source in Providers to install or sign in", () => {
    const { root, onSave } = sources(["codex", "claudeAgent"], all);
    act(() => byLabel(root, "Install: Muse Code").props.onClick());
    expect(onSave).toHaveBeenCalledWith(["codex", "claudeAgent", "muse"]);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: env, instanceId: "muse" },
    });
  });

  it("hides Turn on without permission to manage providers", () => {
    state.canManage = false;
    const { root } = sources(["codex", "claudeAgent"], all);
    expect(
      root.findAll(
        (node) => node.type === "button" && node.props["aria-label"] === "Turn on: Antigravity",
      ),
    ).toHaveLength(0);
  });
});

describe("MissingTrackSource", () => {
  const row = (providers: ReadonlyArray<ServerProvider>, model: string, agents: string[] = []) =>
    render(
      <ul>
        <MissingTrackSource
          environmentId={env}
          providers={providers}
          model={model}
          nowMs={now}
          sourceName={sourceName}
          configuredAgents={new Set(agents)}
        />
      </ul>,
    ).root;

  it("names a missing Muse install and links Install", () => {
    const root = row([codex, claude, muse], "muse-wonder-full-1.0");
    expect(text(root.findByType("li"))).toBe(
      "Not installed Needs Muse Code, not installed. Install",
    );
  });

  it("names an off source and links Turn on", () => {
    const root = row([codex, claude, antigravity], "gemini-4-carbon");
    expect(text(root.findByType("li"))).toBe("Off Needs Antigravity, off. Turn on");
  });

  it("names Gemini CLI when nothing here could run Gemini", () => {
    const root = row([codex, claude], "gemini-4-carbon");
    expect(text(root.findByType("li"))).toBe(
      "Not installed Needs Gemini CLI, not set up on this machine. Open Providers",
    );
  });

  it("keeps the old sentence when nothing could run the model", () => {
    const root = row([codex, claude], "gemini-4-carbon", ["gemini"]);
    expect(text(root.findByType("li"))).toBe("Not installed No source on this machine lists it.");
  });
});
