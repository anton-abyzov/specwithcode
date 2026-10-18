import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ConnectionMatrix } from "./ConnectionMatrix";
import type { NativeConnectionsSnapshot } from "@specweave-studio/contracts";
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
    expect(text()).toContain("Disabled");
    expect(text()).toContain("Not found");
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
    expect(text()).toContain("Unknown");
    expect(text()).not.toContain("Not found");
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
    const notes = renderer.root.findAll(
      (node) => node.props["data-testid"] === "computer-use-connection-note",
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
      renderer = create(<ConnectionMatrix snapshot={grouped} onApply={vi.fn()} />);
    });
    const headers = renderer.root.findAll((n) => n.type === "th" && n.props.scope === "col");
    expect(headers.map((h) => h.children.join(""))).toEqual([
      "Connection",
      "Codex",
      "Claude Code",
      "Gemini CLI",
      "Windsurf",
    ]);
    const groupTitles = renderer.root
      .findAll((n) => n.type === "th" && n.props.scope === "colgroup")
      .map((n) => n.children.join(""));
    expect(groupTitles).toEqual([
      "Your connections · 2",
      "From plugins · 2",
      "Private projects only · 1",
    ]);
    expect(text()).toContain("Plugin GitHub · http");
    expect(text()).toContain("ships it turned off");
    expect(text()).toContain("Private project penn +1 · http");
    expect(text()).toContain("Windsurf (invalid)");
    expect(
      renderer.root.findByProps({ "data-testid": "connection-counts" }).children.join(""),
    ).toBe("Codex 3 · Claude Code 1 · Gemini CLI 1 · Windsurf 0");
    // Plugin and other-project declarations are never copied between tools.
    const labels = renderer.root
      .findAll((n) => n.type === "button" && typeof n.props["aria-label"] === "string")
      .map((n) => n.props["aria-label"] as string);
    expect(labels.filter((l) => l.startsWith("Add to"))).toEqual(["Add to Claude Code: amplitude"]);
    await act(() =>
      renderer.root.findByProps({ "aria-label": "github Codex details" }).props.onClick(),
    );
    expect(text()).toContain("Codex plugin GitHub");
  });
});
