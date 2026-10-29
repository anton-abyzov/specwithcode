import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";
import { ManagedTunnelPolicyContext, useManagedTunnelPolicyLabel } from "./managedTunnelPolicy";

function PolicyLabel() {
  return <span>{useManagedTunnelPolicyLabel()}</span>;
}

describe("Connect account policy presentation", () => {
  it("clears unlimited on account transition and shows the next finite account policy", async () => {
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <ManagedTunnelPolicyContext value={{ kind: "unlimited" }}>
          <PolicyLabel />
        </ManagedTunnelPolicyContext>,
      );
    });
    expect(root.toJSON()).toMatchObject({ children: ["Connect machines: Unlimited"] });
    await act(async () => {
      root.update(
        <ManagedTunnelPolicyContext value={null}>
          <PolicyLabel />
        </ManagedTunnelPolicyContext>,
      );
    });
    expect(root.toJSON()).toMatchObject({ children: null });
    await act(async () => {
      root.update(
        <ManagedTunnelPolicyContext value={{ kind: "limited", maxTunnels: 3 }}>
          <PolicyLabel />
        </ManagedTunnelPolicyContext>,
      );
    });
    expect(root.toJSON()).toMatchObject({ children: ["Connect machines: Up to 3"] });
    await act(async () => root.unmount());
  });
});
