// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { connectAccountStateAtom } from "./connectAccountState";
import {
  clearConnectSessionRecord,
  readConnectSessionRecord,
  writeConnectSessionRecord,
} from "./connectSessionRecord";
import { ManagedRelayAuthProvider } from "./managedAuth";

const auth = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const clerkSession = vi.hoisted(() => ({ current: null as { expireAt: Date } | null }));
const removeRelayEnvironments = vi.hoisted(() =>
  vi.fn(async (_options?: { readonly forgetRemoved?: boolean }) => ({})),
);

vi.mock("@clerk/react", () => ({
  useAuth: () => auth.current,
  useSession: () => ({ session: clerkSession.current }),
}));
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
vi.mock("./ConnectMachineOwnersSync", () => ({ ConnectMachineOwnersSync: () => null }));
vi.mock("./ConnectSessionGuard", () => ({ ConnectSessionGuard: () => null }));
vi.mock("./ConnectRenewResume", () => ({ ConnectRenewResume: () => null }));
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
  clerkSession.current = null;
  clearConnectSessionRecord();
  removeRelayEnvironments.mockClear();
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

const HOUR = 3_600_000;
const signedIn = (userId: string, expireAt: number) => {
  clerkSession.current = { expireAt: new Date(expireAt) };
  return { isLoaded: true, isSignedIn: true, userId, getToken };
};
const signedOut = () => {
  clerkSession.current = null;
  return { isLoaded: true, isSignedIn: false, userId: null, getToken };
};

describe("a sign-out keeps the machines reached through Connect only after an expiry or a renew (1417, AC-16)", () => {
  it("records whose sign-in this is and when it ends", async () => {
    const expireAt = Date.now() + 5 * HOUR;
    await show(signedIn("user-1", expireAt));
    expect(readConnectSessionRecord()).toEqual({ accountId: "user-1", expireAt });
  });

  it("removes them when the sign-in ends early, as a person's sign-out does", async () => {
    await show(signedIn("user-1", Date.now() + 5 * HOUR));
    await show(signedOut());
    expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
    expect(readConnectSessionRecord()).toBeNull();
  });

  it("keeps them when the sign-in ran out while the window was open", async () => {
    await show(signedIn("user-1", Date.now() + 5 * HOUR));
    // Clerk's seven days are up.
    writeConnectSessionRecord({ accountId: "user-1", expireAt: Date.now() - 1 });
    await show(signedOut());
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(readConnectSessionRecord()?.accountId).toBe("user-1");
  });

  it("keeps them when the window opens after the sign-in ran out", async () => {
    writeConnectSessionRecord({ accountId: "user-1", expireAt: Date.now() - HOUR });
    await show({ isLoaded: false, isSignedIn: undefined, userId: null, getToken });
    await show(signedOut());
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
  });

  it("removes them at a signed-out start with no record, as before", async () => {
    await show(signedOut());
    expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
  });

  it("keeps them through a renew, and the same account signing in keeps them", async () => {
    const expireAt = Date.now() + 5 * HOUR;
    await show(signedIn("user-1", expireAt));
    writeConnectSessionRecord({ accountId: "user-1", expireAt, renewStartedAt: Date.now() });
    await show(signedOut());
    await show(signedIn("user-1", Date.now() + 7 * 24 * HOUR));
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    expect(readConnectSessionRecord()?.renewStartedAt).toBeUndefined();
  });

  it("removes kept machines before another account's session starts", async () => {
    writeConnectSessionRecord({ accountId: "user-1", expireAt: Date.now() - HOUR });
    await show(signedOut());
    expect(removeRelayEnvironments).not.toHaveBeenCalled();
    const expireAt = Date.now() + 7 * 24 * HOUR;
    await show(signedIn("user-2", expireAt));
    expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
    expect(readConnectSessionRecord()).toEqual({ accountId: "user-2", expireAt });
  });

  it("removes kept machines when the window opens signed in as another account", async () => {
    writeConnectSessionRecord({ accountId: "user-1", expireAt: Date.now() - HOUR });
    await show(signedIn("user-2", Date.now() + 7 * 24 * HOUR));
    expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
  });

  it("a switch's relay cleanup leaves skip markers; a sign-out's does not (1434, AC-05, D-02)", async () => {
    await show(signedIn("user-1", Date.now() + 5 * HOUR));
    await show(signedIn("user-2", Date.now() + 5 * HOUR));
    expect(removeRelayEnvironments).toHaveBeenLastCalledWith({ forgetRemoved: true });
    removeRelayEnvironments.mockClear();
    await show(signedOut());
    expect(removeRelayEnvironments).toHaveBeenCalledTimes(1);
    expect(removeRelayEnvironments).not.toHaveBeenCalledWith({ forgetRemoved: true });
  });
});
