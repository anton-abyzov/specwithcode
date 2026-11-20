import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import { useAuth } from "@clerk/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";
import { useConnectSignInNotice } from "./useConnectSignInNotice";

/**
 * Electron half of the managed-auth boundary. The Electron provider statically
 * bundles the full clerk-js runtime, so this module must only ever load
 * lazily, and only inside the desktop shell — importing it eagerly would put
 * clerk-js back into every client's startup graph.
 */
export default function ElectronManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey} passkeys={passkeys}>
      <ConnectSignInNotice />
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}

/** Signing in through another site continues in the system browser; this says so. */
function ConnectSignInNotice(): null {
  const { isSignedIn } = useAuth();
  useConnectSignInNotice(isSignedIn === true);
  return null;
}
