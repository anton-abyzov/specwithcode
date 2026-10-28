import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ConnectionMatrix, FOLDER_ONLY_NOTE, PER_TOOL_NOTE } from "./ConnectionMatrix";
import type { NativeConnectionsSnapshot } from "@specweave-studio/contracts";
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({ render, children }: { render?: ReactNode; children?: ReactNode }) {
      return isValidElement(render) ? cloneElement(render, undefined, children) : children;
    },
    TooltipPopup: () => null,
  };
});

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const snapshot: NativeConnectionsSnapshot = {
  observedAt: "2026-10-14T00:00:00Z",
  runtime: "unverified",
  truncated: false,
  sources: [
    { id: "codex-user", provider: "codex", scope: "user", status: "read" },
    { id: "claude-user", provider: "claude", scope: "user", status: "read" },
  ],
  connections: [
    {
      id: "one",
      name: "PostHog",
      provider: "codex",
      sourceId: "codex-user",
      scope: "user",
      transport: "http",
      state: "configured",
      shadowed: true,
    },
    {
      id: "two",
      name: "PostHog",
      provider: "codex",
      sourceId: "codex-project",
      scope: "project",
      transport: "http",
      state: "disabled",
      shadowed: false,
    },
  ],
};
const text = () => JSON.stringify(renderer.toJSON());
describe("connection matrix", () => {
  it("shows per-client declarations, project overrides, provenance and unverified access", async () => {
    await act(() => {
      renderer = create(<ConnectionMatrix snapshot={snapshot} project />);
    });
    expect(text()).toContain("Disabled in Codex");
    expect(text()).toContain("Not set up in Claude Code");
    await act(() =>
      renderer.root.findByProps({ "aria-label": "PostHog Codex details" }).props.onClick(),
    );
    expect(text()).toContain("Project .codex/config.toml");
    expect(text()).toContain("Codex user config.toml (overridden)");
    expect(text()).toContain("Not checked");
    expect(text()).toContain("manages native access");
    await act(() =>
      renderer.root
        .findAllByType("button")
        .find((b) => b.children.includes("Close details"))!
        .props.onClick(),
    );
    expect(text()).not.toContain("Access owner");
  });
  it("uses unknown for absent cells when the provider scan failed", async () => {
    await act(() => {
      renderer = create(
        <ConnectionMatrix
          snapshot={{
            ...snapshot,
            sources: [{ id: "claude-user", provider: "claude", scope: "user", status: "invalid" }],
          }}
        />,
      );
    });
    expect(text()).toContain("Unknown in Claude Code");
    expect(text()).not.toContain("Not set up in");
    expect(text()).toContain("Results are incomplete");
  });
  it("keeps empty, failed and truncated scans distinct", async () => {
    await act(() => {
      renderer = create(<ConnectionMatrix snapshot={{ ...snapshot, connections: [] }} />);
    });
    expect(text()).toContain("No MCP declarations found");
    await act(() =>
      renderer.update(
        <ConnectionMatrix snapshot={{ ...snapshot, connections: [], truncated: true }} />,
      ),
    );
    expect(text()).toContain("No declarations could be confirmed");
    expect(text()).not.toContain("No MCP declarations found");
  });
  it("removes selection details when the refreshed server disappears", async () => {
    await act(() => {
      renderer = create(<ConnectionMatrix snapshot={snapshot} />);
    });
    await act(() =>
      renderer.root.findByProps({ "aria-label": "PostHog Codex details" }).props.onClick(),
    );
    await act(() =>
      renderer.update(<ConnectionMatrix snapshot={{ ...snapshot, connections: [] }} />),
    );
    expect(text()).not.toContain("Access owner");
  });
  it("offers Enable and Add only where the change can run, and explains the rest", async () => {
    const onApply = vi.fn();
    const base = { sourceId: "codex-user", scope: "user", shadowed: false } as const;
    const actionable: NativeConnectionsSnapshot = {
      ...snapshot,
      connections: [
        {
          ...base,
          id: "cu",
          name: "computer-use",
          provider: "codex",
          transport: "stdio",
          state: "disabled",
          portable: false,
          pluginProvided: true,
        },
        {
          ...base,
          id: "docs",
          name: "docs",
          provider: "codex",
          transport: "stdio",
          state: "disabled",
          portable: true,
        },
        {
          ...base,
          id: "amp",
          name: "amplitude",
          provider: "claude",
          sourceId: "claude-user",
          transport: "http",
          state: "configured",
          portable: true,
        },
      ],
    };
    await act(() => {
      renderer = create(<ConnectionMatrix snapshot={actionable} onApply={onApply} />);
    });
    const button = (label: string) =>
      renderer.root.findAll((node) => node.type === "button" && node.props["aria-label"] === label);
    expect(button("Enable: computer-use")).toHaveLength(0);
    expect(text()).toContain("so this older entry can stay off");
    // The note slot appears only under the computer-use row, and only when given.
    expect(
      renderer.root.findAll((node) => node.props["data-testid"] === "computer-use-connection-note"),
    ).toHaveLength(0);
    expect(text()).toContain("Claude Code has no equivalent entry");
    // Compact cells hold one mark each: Add stays a mark, Enable moves to the details.
    expect(button("Enable: docs")).toHaveLength(0);
    await act(() => button("Add to Codex: amplitude")[0]!.props.onClick());
    expect(onApply).toHaveBeenCalledWith({ action: "copy", connectionId: "amp" });
    await act(() =>
      renderer.root
        .findAll((n) => n.type === "button" && n.children.includes("Detailed"))[0]!
        .props.onClick(),
    );
    await act(() => button("Enable: docs")[0]!.props.onClick());
    expect(onApply).toHaveBeenCalledWith({ action: "enable", connectionId: "docs" });
    await act(() => button("Add to Codex: amplitude")[0]!.props.onClick());
    expect(onApply).toHaveBeenCalledWith({ action: "copy", connectionId: "amp" });
    // A disabled declaration is not copied, and nothing is offered without edit access.
    expect(button("Add to Claude Code: docs")).toHaveLength(0);
    await act(() => {
      renderer.update(<ConnectionMatrix snapshot={actionable} />);
    });
    expect(button("Enable: docs")).toHaveLength(0);
    await act(() => {
      renderer.update(
        <ConnectionMatrix snapshot={actionable} computerUseNote={<span>permission check</span>} />,
      );
    });
    // The note sits in the row's details, opened from the row name.
    expect(
      renderer.root.findAll((node) => node.props["data-testid"] === "computer-use-connection-note"),
    ).toHaveLength(0);
    await act(() =>
      renderer.root.findByProps({ "aria-label": "computer-use row details" }).props.onClick(),
    );
    const notes = renderer.root.findAll(
      (node) => node.type === "div" && node.props["data-testid"] === "computer-use-connection-note",
    );
    expect(notes).toHaveLength(1);
    expect(text()).toContain("permission check");
  });
  it("groups plugin and private-project rows and adds a read-only column per other tool", async () => {
    const base = {
      scope: "user",
      shadowed: false,
      transport: "http",
      state: "configured",
    } as const;
    const grouped: NativeConnectionsSnapshot = {
      ...snapshot,
      connections: [
        {
          ...base,
          id: "a",
          name: "amplitude",
          provider: "codex",
          sourceId: "codex-user",
          portable: true,
        },
        {
          ...base,
          id: "g",
          name: "github",
          provider: "codex",
          sourceId: "codex-plugins",
          plugin: "GitHub",
        },
        {
          ...base,
          id: "r",
          name: "review",
          provider: "codex",
          sourceId: "codex-plugins",
          plugin: "Code Review",
          state: "disabled",
        },
        {
          ...base,
          id: "p1",
          name: "playwright",
          provider: "claude",
          sourceId: "claude-all-projects",
          scope: "local",
          project: "penn",
        },
        {
          ...base,
          id: "p2",
          name: "playwright",
          provider: "claude",
          sourceId: "claude-all-projects",
          scope: "local",
          project: "ClientPortal",
        },
      ],
      otherTools: [
        {
          tool: "gemini",
          status: "read",
          connections: [{ id: "x", name: "pencil", transport: "stdio", state: "configured" }],
        },
        { tool: "cursor", status: "missing", connections: [] },
        { tool: "windsurf", status: "invalid", connections: [] },
      ],
    };
    await act(() => {
      renderer = create(
        <ConnectionMatrix snapshot={grouped} onApply={vi.fn()} initialDensity="detailed" />,
      );
    });
    const headers = renderer.root.findAll((n) => n.type === "th" && n.props.scope === "col");
    expect(headers.map((h) => h.children.join(""))).toEqual([
      "Server",
      "Codex",
      "Claude Code",
      "Gemini CLI",
      "Windsurf",
    ]);
    const groupTitles = renderer.root
      .findAll((n) => n.type === "button" && n.props.className === "connection-group-toggle")
      .map((n) => n.children.filter((c) => typeof c === "string").join(""));
    expect(groupTitles).toEqual([
      "Your connections · 2",
      "From plugins · 2",
      "Only in one folder (Claude Code) · 1",
    ]);
    expect(text()).toContain("Plugin GitHub · http");
    expect(text()).toContain("ships it turned off");
    expect(text()).toContain("Claude Code, only in penn and 1 more folder · http");
    // The group says what a folder-only entry is and that nothing else gets it.
    expect(
      renderer.root.findByProps({ "data-testid": "folder-only-note" }).findByProps({ role: "note" })
        .props["aria-label"],
    ).toBe(FOLDER_ONLY_NOTE);
    expect(FOLDER_ONLY_NOTE).toContain("only when it runs in that folder");
    expect(FOLDER_ONLY_NOTE).toContain("Other folders, projects and providers do not get them");
    expect(FOLDER_ONLY_NOTE).toContain("~/.claude.json");
    expect(text()).not.toMatch(/[Pp]rivate project/);
    expect(text()).toContain("Windsurf (invalid)");
    // Each tool chip counts the servers enabled in it.
    const toolChips = renderer.root
      .findByProps({ "aria-label": "Filter by AI tool" })
      .findAllByType("button")
      .map((b) => b.props["aria-label"]);
    expect(toolChips).toEqual([
      "All tools",
      "Codex enabled (2)",
      "Claude Code enabled (1)",
      "Gemini CLI enabled (1)",
      "Windsurf enabled (0)",
    ]);
    expect(text()).toContain(PER_TOOL_NOTE);
    // Plugin and other-project declarations are never copied between tools.
    const labels = renderer.root
      .findAll((n) => n.type === "button" && typeof n.props["aria-label"] === "string")
      .map((n) => n.props["aria-label"] as string);
    expect(labels.filter((l) => l.startsWith("Add to"))).toEqual(["Add to Claude Code: amplitude"]);
    await act(() =>
      renderer.root.findByProps({ "aria-label": "github Codex details" }).props.onClick(),
    );
    expect(text()).toContain("Codex plugin GitHub");
    await act(() =>
      renderer.root.findByProps({ "aria-label": "playwright Claude Code details" }).props.onClick(),
    );
    expect(text()).toContain("Claude Code, only in penn (~/.claude.json)");
    expect(text()).toContain("Claude Code, only in ClientPortal (~/.claude.json)");
    expect(text()).not.toMatch(/[Pp]rivate project/);
  });
  it("offers turn off, copy everywhere, remove and plugin toggles from the details", async () => {
    const onApply = vi.fn();
    const managed: NativeConnectionsSnapshot = {
      ...snapshot,
      connections: [
        {
          id: "codex:codex-user:a",
          name: "docs",
          provider: "codex",
          sourceId: "codex-user",
          scope: "user",
          transport: "stdio",
          state: "configured",
          shadowed: false,
          portable: true,
        },
        {
          id: "claude:claude-user:b",
          name: "notes",
          provider: "claude",
          sourceId: "claude-user",
          scope: "user",
          transport: "stdio",
          state: "disabled",
          shadowed: false,
          parked: true,
        },
      ],
      plugins: [
        { provider: "claude", key: "web@market", label: "Web", enabled: false },
        { provider: "codex", key: "pay@x-remote", label: "Pay", enabled: true, account: true },
        {
          provider: "codex",
          key: "notes@x-remote",
          label: "Notes",
          enabled: true,
          account: true,
          switchable: false,
        },
      ],
    };
    await act(() => {
      renderer = create(<ConnectionMatrix snapshot={managed} onApply={onApply} />);
    });
    const byLabel = (label: string) =>
      renderer.root.findAll((n) => n.type === "button" && n.props["aria-label"] === label);
    await act(() => byLabel("docs Codex details")[0]!.props.onClick());
    for (const label of ["Turn off: docs", "Add to all tools: docs", "Remove: docs"])
      expect(byLabel(label)).toHaveLength(1);
    await act(() => byLabel("Add to all tools: docs")[0]!.props.onClick());
    expect(onApply).toHaveBeenLastCalledWith({
      action: "copyAll",
      connectionId: "codex:codex-user:a",
    });
    // A parked Claude Code entry turns on from its details.
    await act(() => byLabel("notes Claude Code details")[0]!.props.onClick());
    await act(() => byLabel("Turn on: notes")[0]!.props.onClick());
    expect(onApply).toHaveBeenLastCalledWith({
      action: "enable",
      connectionId: "claude:claude-user:b",
    });
    await act(() => byLabel("Turn on plugin: Web")[0]!.props.onClick());
    expect(onApply).toHaveBeenLastCalledWith({
      action: "plugin",
      provider: "claude",
      pluginKey: "web@market",
      enabled: true,
    });
    // An account plugin switches only its skills; one without skills has no switch at all.
    expect(text()).toContain("Skills on");
    expect(byLabel("Turn off skills: Pay")).toHaveLength(1);
    expect(text()).toContain("Managed in your ChatGPT account");
    expect(byLabel("Turn off skills: Notes")).toHaveLength(0);
  });
  it("filters by tool, status and search, enabled first, and clears", async () => {
    const base = { scope: "user", shadowed: false, transport: "stdio", portable: true } as const;
    const wide: NativeConnectionsSnapshot = {
      ...snapshot,
      connections: [
        {
          ...base,
          id: "c1",
          name: "alpha",
          provider: "codex",
          sourceId: "codex-user",
          state: "configured",
        },
        {
          ...base,
          id: "c2",
          name: "beta",
          provider: "codex",
          sourceId: "codex-user",
          state: "disabled",
        },
        {
          ...base,
          id: "k1",
          name: "beta",
          provider: "claude",
          sourceId: "claude-user",
          state: "configured",
        },
        {
          ...base,
          id: "k2",
          name: "gamma",
          provider: "claude",
          sourceId: "claude-user",
          state: "configured",
        },
      ],
      otherTools: [
        {
          tool: "opencode",
          status: "read",
          connections: [{ id: "o1", name: "delta", transport: "stdio", state: "configured" }],
        },
      ],
    };
    await act(() => {
      renderer = create(<ConnectionMatrix snapshot={wide} />);
    });
    const rowNames = () =>
      renderer.root
        .findAll((n) => n.type === "button" && n.props.className === "connection-name")
        .map((n) => n.props.title as string);
    const press = (label: string) =>
      act(() =>
        renderer.root
          .findAll(
            (n) => n.type === "button" && String(n.props["aria-label"]).startsWith(label),
          )[0]!
          .props.onClick(),
      );
    // beta is enabled in one tool and declared in two, so it leads.
    expect(rowNames()).toEqual(["beta", "alpha", "delta", "gamma"]);
    await press("Codex enabled");
    expect(rowNames()).toEqual(["alpha", "beta"]);
    const headers = () =>
      renderer.root
        .findAll((n) => n.type === "th" && n.props.scope === "col")
        .map((h) => h.children.join(""));
    expect(headers()).toEqual(["Server", "Codex"]);
    await press("Claude Code enabled");
    await press("Partly set up");
    expect(rowNames()).toEqual(["alpha", "gamma"]);
    await press("Disabled");
    expect(rowNames()).toEqual(["beta"]);
    await act(() =>
      renderer.root
        .findByProps({ "aria-label": "Search connections" })
        .props.onChange({ target: { value: "zzz" } }),
    );
    expect(text()).toContain("No connections match these filters.");
    await act(() =>
      renderer.root
        .findAll((n) => n.type === "button" && n.children.includes("Clear filters"))[0]!
        .props.onClick(),
    );
    expect(rowNames()).toEqual(["beta", "alpha", "delta", "gamma"]);
    expect(headers()).toEqual(["Server", "Codex", "Claude Code", "OpenCode"]);
  });
  it("copies a declaration's file and key, never its command", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await act(() => {
      renderer = create(<ConnectionMatrix snapshot={snapshot} project />);
    });
    await act(() =>
      renderer.root.findByProps({ "aria-label": "PostHog Codex details" }).props.onClick(),
    );
    await act(() =>
      renderer.root
        .findAll(
          (n) => n.type === "button" && String(n.props["aria-label"]).startsWith("Copy location"),
        )[0]!
        .props.onClick(),
    );
    expect(writeText).toHaveBeenCalledWith(".codex/config.toml [mcp_servers.PostHog]");
    expect(text()).toContain("Copied");
    // A kept-aside entry is not in the tool's file, so there is no location to copy.
    await act(() =>
      renderer.update(
        <ConnectionMatrix
          snapshot={{
            ...snapshot,
            connections: [
              {
                id: "parked",
                name: "notes",
                provider: "claude",
                sourceId: "claude-user",
                scope: "user",
                transport: "stdio",
                state: "disabled",
                shadowed: false,
                parked: true,
              },
            ],
          }}
        />,
      ),
    );
    await act(() =>
      renderer.root.findByProps({ "aria-label": "notes Claude Code details" }).props.onClick(),
    );
    expect(
      renderer.root.findAll(
        (n) => n.type === "button" && String(n.props["aria-label"]).startsWith("Copy location"),
      ),
    ).toHaveLength(0);
  });
  it("explains every cell state in its tooltip text and shows a legend", async () => {
    const base = { scope: "user", shadowed: false, transport: "stdio" } as const;
    await act(() => {
      renderer = create(
        <ConnectionMatrix
          onApply={vi.fn()}
          snapshot={{
            ...snapshot,
            connections: [
              {
                ...base,
                id: "a",
                name: "alpha",
                provider: "claude",
                sourceId: "claude-user",
                state: "configured",
                portable: true,
              },
              {
                ...base,
                id: "b",
                name: "beta",
                provider: "codex",
                sourceId: "codex-user",
                state: "invalid",
              },
            ],
          }}
        />,
      );
    });
    expect(text()).toContain(
      "Enabled in Claude Code. User · stdio Select for details and actions.",
    );
    expect(text()).toContain("Select + to copy the Claude Code entry.");
    expect(text()).toContain("Invalid declaration in Codex.");
    const legend = renderer.root
      .findByProps({ "aria-label": "Status legend" })
      .findAll((n) => n.props.className === "connection-legend-item")
      .map((n) => n.children.filter((c) => typeof c === "string").join(""));
    expect(legend).toEqual(["Enabled", "Disabled", "Can add", "Not set up", "Invalid"]);
  });
});
