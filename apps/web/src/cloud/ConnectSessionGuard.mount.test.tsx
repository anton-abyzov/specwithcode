import { ConnectionBlockedError } from "@specweave-studio/client-runtime/connection";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// A fake registry and discovery store: the guard reads the listing through
// both the hook and the registry, and writes its report to the registry.
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: { error: null as unknown, refreshing: false, offline: false },
    rejected: false,
    listeners,
    set(next: { error: unknown; refreshing?: boolean; offline?: boolean }) {
      store.state = { refreshing: false, offline: false, ...next };
      for (const listener of listeners) listener();
    },
  };
});
const refresh = vi.hoisted(() => vi.fn());
const STATE_ATOM = vi.hoisted(() => ({ name: "discovery-state" }));

vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: async () => "fresh-token" }) }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => (atom === STATE_ATOM ? store.state : store.rejected),
    set: (_atom: unknown, value: boolean) => {
      store.rejected = value;
    },
  },
}));
vi.mock("../state/relay", () => ({
  relayEnvironmentDiscovery: { refresh: {}, stateValueAtom: STATE_ATOM },
}));
vi.mock("../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useRelayEnvironmentDiscovery: () =>
      useSyncExternalStore(
        (listener) => {
          store.listeners.add(listener);
          return () => store.listeners.delete(listener);
        },
        () => store.state,
      ),
  };
});
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => refresh }));
vi.mock("./publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));

import { ConnectSessionGuard } from "./ConnectSessionGuard";

const refused = () =>
  Option.some(
    new ConnectionBlockedError({
      reason: "authentication",
      detail: "Relay rejected the cloud session token.",
      connectSessionRefused: true,
    }),
  );

async function settle() {
  for (let turn = 0; turn < 20; turn++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  store.listeners.clear();
  store.rejected = false;
  refresh.mockReset();
});

describe("ConnectSessionGuard while the relay keeps refusing the sign-in (1417, AC-13)", () => {
  it("checks once with a fresh token, reports it, and never signs out or checks again by itself", async () => {
    store.set({ error: refused() });
    // Each check's own listing makes a new refusal, as the relay client does.
    refresh.mockImplementation(async () => store.set({ error: refused() }));
    await act(async () => {
      renderer = create(<ConnectSessionGuard />);
    });
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.rejected).toBe(true);
  });

  it("checks again for a later listing that is refused, once", async () => {
    store.set({ error: refused() });
    refresh.mockImplementation(async () => store.set({ error: refused() }));
    await act(async () => {
      renderer = create(<ConnectSessionGuard />);
    });
    await settle();
    await act(async () => store.set({ error: refused() }));
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("says nothing from a check that ends after its account's guard went away", async () => {
    store.set({ error: refused() });
    let finish = () => {};
    refresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            store.set({ error: refused() });
            resolve();
          };
        }),
    );
    await act(async () => {
      renderer = create(<ConnectSessionGuard />);
    });
    await settle();
    await act(async () => renderer?.unmount());
    renderer = null;
    await act(async () => finish());
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.rejected).toBe(false);
  });

  it("checks a refusal again once it is back online, never while offline", async () => {
    store.set({ error: refused() });
    // Offline, the refresh leaves the refusal it started from.
    refresh.mockImplementationOnce(async () => store.set({ error: store.state.error, offline: true }));
    await act(async () => {
      renderer = create(<ConnectSessionGuard />);
    });
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.rejected).toBe(false);
    // Back online: the listing comes back refused, and this time the check answers.
    refresh.mockImplementation(async () => store.set({ error: refused() }));
    await act(async () => store.set({ error: refused() }));
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(store.rejected).toBe(true);
  });

  it("clears the report once a listing is accepted", async () => {
    store.set({ error: refused() });
    refresh.mockImplementation(async () => store.set({ error: refused() }));
    await act(async () => {
      renderer = create(<ConnectSessionGuard />);
    });
    await settle();
    expect(store.rejected).toBe(true);
    await act(async () => store.set({ error: Option.none() }));
    await settle();
    expect(store.rejected).toBe(false);
  });
});
