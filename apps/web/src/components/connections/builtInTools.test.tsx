import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, hash, children, ...rest }: { to: string; hash: string; children: ReactNode }) => (
    <a href={hash ? `${to}#${hash}` : to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../../state/device", () => ({ useDeviceState: () => ({ state: { hosts: [] } }) }));
vi.mock("../../state/environments", () => ({ useEnvironment: () => null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: {} }));

import { BuiltInToolsList } from "./BuiltInToolsBlock";
import { BUILT_IN_TOOLS, builtInToolStatus, type BuiltInToolFacts } from "./builtInTools";

const mac: BuiltInToolFacts = {
  os: "darwin",
  computerAccess: true,
  browserAccess: true,
  deviceSupport: true,
  chromePaired: true,
  simulatorReady: true,
};

describe("builtInToolStatus", () => {
  it.each([
    ["chrome", mac, "paired"],
    ["chrome", { ...mac, chromePaired: false }, "needs-setup"],
    ["chrome", { ...mac, chromePaired: null }, null],
    ["computer-use", mac, "on"],
    ["computer-use", { ...mac, computerAccess: false }, "off"],
    ["computer-use", { ...mac, os: "linux" }, "mac-only"],
    ["computer-use", { ...mac, os: undefined }, null],
    ["in-app-browser", mac, "on"],
    ["in-app-browser", { ...mac, browserAccess: false }, "off"],
    ["simulators", mac, "on"],
    ["simulators", { ...mac, simulatorReady: false }, "needs-setup"],
    ["simulators", { ...mac, deviceSupport: false }, "off"],
    ["simulators", { ...mac, simulatorReady: null }, null],
  ] as const)("%s reads %o as %s", (id, facts, status) => {
    expect(builtInToolStatus(id, facts)).toBe(status);
  });
});

describe("BuiltInToolsList", () => {
  let renderer: ReactTestRenderer | null = null;
  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = null;
  });
  const render = async (facts: BuiltInToolFacts) => {
    await act(() => {
      renderer = create(<BuiltInToolsList facts={facts} />);
    });
    return renderer!.root;
  };
  const row = (root: ReactTestRenderer["root"], id: string) =>
    root.find((node) => node.props["data-testid"] === `built-in-${id}`);
  const status = (root: ReactTestRenderer["root"], id: string) =>
    row(root, id).findAll((node) => node.props["data-status"] !== undefined)[0]?.props[
      "data-status"
    ] ?? null;

  it("names the four tools and says they are never added as servers", async () => {
    const root = await render(mac);
    expect(BUILT_IN_TOOLS.map((tool) => tool.name)).toEqual([
      "Chrome",
      "Computer use",
      "In-app browser",
      "Simulators",
    ]);
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "You never add them as MCP servers, so they are not in the list below.",
    );
    expect(root.findAll((node) => node.type === "li")).toHaveLength(4);
  });

  it("shows each tool's live status on the machine", async () => {
    const root = await render({
      ...mac,
      os: "linux",
      browserAccess: false,
      simulatorReady: false,
    });
    expect(status(root, "chrome")).toBe("paired");
    expect(status(root, "computer-use")).toBe("mac-only");
    expect(status(root, "in-app-browser")).toBe("off");
    expect(status(root, "simulators")).toBe("needs-setup");
  });

  it("shows no status until the machine has answered", async () => {
    const root = await render({ ...mac, chromePaired: null });
    expect(status(root, "chrome")).toBeNull();
    expect(status(root, "computer-use")).toBe("on");
  });

  it("links each tool to where it is set up", async () => {
    const root = await render(mac);
    const href = (id: string) => row(root, id).find((node) => node.type === "a").props.href;
    expect(href("chrome")).toBe("/settings/chrome");
    expect(href("computer-use")).toBe("/settings/integrations/access#agent-computer-access");
    expect(href("in-app-browser")).toBe("/settings/integrations/access#agent-browser-access");
    expect(href("simulators")).toBe("/settings/integrations/devices#devices");
  });
});
