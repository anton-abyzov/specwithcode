import { createContext, useContext } from "react";
import type { RelayManagedTunnelPolicy } from "@specweave-studio/contracts/relay";

export const ManagedTunnelPolicyContext = createContext<RelayManagedTunnelPolicy | null>(null);

export function useManagedTunnelPolicyLabel(): string | null {
  const policy = useContext(ManagedTunnelPolicyContext);
  return policy === null
    ? null
    : policy.kind === "unlimited"
      ? "Connect machines: Unlimited"
      : `Connect machines: Up to ${policy.maxTunnels.toLocaleString("en-US")}`;
}
