import { ProviderDriverKind } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import {
  ProviderInstanceIcon,
  resolveProviderInstanceAcpRegistryIconUrl,
} from "./ProviderInstanceIcon";

type IconProps = Parameters<typeof ProviderInstanceIcon.type>[0];

/** The brand the icon draws, read from the element tree without a DOM. */
function drawnBrand(props: IconProps): unknown {
  const tree = (ProviderInstanceIcon.type as (props: IconProps) => unknown)(props);
  return visitElements(tree, (element) => typeof element.props.brand === "string")?.props.brand;
}

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });

  it("does not resolve registry icons for other provider drivers", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("codex"),
        agentId: "kilo",
      }),
    ).toBeNull();
  });
});

describe("ProviderInstanceIcon open-model mark", () => {
  const claude = ProviderDriverKind.make("claudeAgent");

  it("draws the preset vendor's mark for a Claude Code instance with the marker", () => {
    expect(
      drawnBrand({ driverKind: claude, displayName: "Z.ai GLM", openModelPreset: "zai" }),
    ).toBe("zai");
    expect(
      drawnBrand({ driverKind: claude, displayName: "My box", openModelPreset: "lmstudio" }),
    ).toBe("lmstudio");
  });

  it("keeps the Claude mark without the marker, and other drivers' marks", () => {
    // A hand-built instance named after a vendor is still Claude Code.
    expect(drawnBrand({ driverKind: claude, displayName: "DeepSeek" })).toBe("claude");
    expect(
      drawnBrand({
        driverKind: ProviderDriverKind.make("pi"),
        displayName: "Pi",
        openModelPreset: "deepseek",
      }),
    ).toBe("pi");
  });
});
