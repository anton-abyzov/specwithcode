import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { connectAccountStateAtom } from "./connectAccountState";
import { ManagedRelayAuthProvider } from "./managedAuth";

const auth = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const removeRelayEnvironments = vi.hoisted(() => async () => ({}));

vi.mock("@clerk/react", () => ({ useAuth: () => auth.current }));
vi.mock("@specweave-studio/client-runtime/relay", () => ({
  ManagedRelay: { ManagedRelayClient: { pipe: () => ({}) } },
  setManagedRelaySession: () => {},
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  reportAtomCommandResult: () => {},
  settleAsyncResult: async (run: () => unknown) => run(),
  settlePromise: async (run: () => Promise<unknown>) => {
    await run();
    return {};
  },
}));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { removeRelayEnvironments: {} } }));
vi.mock("../lib/runtime", () => ({
  runtime: { runPromise: async () => null, runPromiseExit: async () => ({}) },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => removeRelayEnvironments }));
vi.mock("./ConnectRouteReconciler", () => ({ ConnectRouteReconciler: () => null }));
vi.mock("./ConnectSessionGuard", () => ({ ConnectSessionGuard: () => null }));
vi.mock("./publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));

const getToken = async () => null;
const account = () => appAtomRegistry.get(connectAccountStateAtom);

let renderer: ReactTestRenderer | null = null;
async function show(next: Record<string, unknown>) {
  auth.current = next;
  await act(async () => {
    if (renderer === null)
      renderer = create(<ManagedRelayAuthProvider>{null}</ManagedRelayAuthProvider>);
    else renderer.update(<ManagedRelayAuthProvider>{null}</ManagedRelayAuthProvider>);
  });
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("the provider writes this window's Connect account state (1417)", () => {
  it("stays unknown while Clerk loads, then follows Clerk's settled answer", async () => {
    await show({ isLoaded: false, isSignedIn: undefined, userId: null, getToken });
    expect(account()).toBe("unknown");
    await show({ isLoaded: true, isSignedIn: false, userId: null, getToken });
    expect(account()).toBe("signed-out");
    await show({ isLoaded: true, isSignedIn: true, userId: "user-1", getToken });
    expect(account()).toBe("signed-in");
    await show({ isLoaded: true, isSignedIn: false, userId: null, getToken });
    expect(account()).toBe("signed-out");
  });

  it("goes back to unknown when Clerk reloads or the provider unmounts", async () => {
    await show({ isLoaded: true, isSignedIn: false, userId: null, getToken });
    expect(account()).toBe("signed-out");
    await show({ isLoaded: false, isSignedIn: undefined, userId: null, getToken });
    expect(account()).toBe("unknown");
    await show({ isLoaded: true, isSignedIn: false, userId: null, getToken });
    await act(async () => renderer?.unmount());
    renderer = null;
    expect(account()).toBe("unknown");
  });
});
