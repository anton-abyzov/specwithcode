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
});
