import type { DesktopConnectSignInState } from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => {
  // What the person would see: the toast ids on screen, newest first.
  const shown: string[] = [];
  const calls: string[] = [];
  return {
    shown,
    calls,
    add: vi.fn((options: { id?: string | undefined; title?: unknown }) => {
      const id = String(options.id);
      calls.push(`add ${String(options.title)}`);
      // Adding an id that is still showing updates it where it is.
      if (!shown.includes(id)) shown.unshift(id);
      return id;
    }),
    close: vi.fn((id?: string) => {
      calls.push("close");
      if (id !== undefined && shown.includes(id)) shown.splice(shown.indexOf(id), 1);
    }),
  };
});
// Clerk's session as a small store, so a sign-in re-renders its readers as the real hook does.
const auth = vi.hoisted(() => {
  let signedIn = false;
  const readers = new Set<() => void>();
  return {
    get: () => signedIn,
    set: (value: boolean) => {
      signedIn = value;
      for (const reader of readers) reader();
    },
    subscribe: (reader: () => void) => {
      readers.add(reader);
      return () => {
        readers.delete(reader);
      };
    },
  };
});
vi.mock("../ui/toast", () => ({ toastManager: toasts }));
vi.mock("@clerk/electron/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@clerk/react", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useAuth: () => ({ isSignedIn: useSyncExternalStore(auth.subscribe, auth.get) }) };
});
vi.mock("@clerk/electron/passkeys", () => ({ passkeys: {} }));
vi.mock("../../cloud/managedAuth", () => ({
  ManagedRelayAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./clerkAppearance", () => ({ clerkAppearance: {} }));

import ElectronManagedAuthShell from "./ElectronManagedAuthShell";
import {
  CONNECT_SIGN_IN_NOTICE_ID,
  createConnectSignInNotice,
  useConnectSignInNotice,
} from "./useConnectSignInNotice";

type Listener = (state: DesktopConnectSignInState) => void;

function makeBridge() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    emit: (state: DesktopConnectSignInState) => {
      for (const listener of listeners) listener(state);
    },
    bridge: {
      onConnectSignInState: vi.fn((listener: Listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    },
  };
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  toasts.shown.length = 0;
  toasts.calls.length = 0;
  auth.set(false);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const lastNotice = () => toasts.add.mock.calls.at(-1)![0];
const isNotice = (id: string) => id.startsWith(`${CONNECT_SIGN_IN_NOTICE_ID}-`);
const noticesShown = () => toasts.shown.filter(isNotice);

describe("the Connect sign-in notice", () => {
  it("says the sign-in continues in the browser and where to look", () => {
    createConnectSignInNotice(toasts).show("waiting");
    expect(toasts.add.mock.calls).toEqual([
      [
        {
          id: `${CONNECT_SIGN_IN_NOTICE_ID}-1`,
          type: "loading",
          title: "Finish signing in in your browser",
          description:
            "The sign-in page opened in your browser. If you don't see it, look for a new browser tab or window. To open it again, close this window and sign in again.",
          timeout: 0,
          data: { aboveSignInDialog: true, hideCopyButton: true },
        },
      ],
    ]);
  });

  it("says the browser could not be opened and what to do", () => {
    createConnectSignInNotice(toasts).show("open-failed");
    expect(lastNotice()).toMatchObject({
      type: "error",
      title: "Couldn't open your browser",
      description: "Open a browser on this computer, then click the button again.",
      timeout: 0,
    });
  });

  it("says the sign-in did not finish and that clicking again retries", () => {
    createConnectSignInNotice(toasts).show("timed-out");
    expect(lastNotice()).toMatchObject({
      type: "warning",
      title: "Sign-in didn't finish",
      description:
        "The browser didn't come back within 3 minutes. Click the button again to retry.",
      timeout: 0,
    });
  });

  it("keeps one notice, in front of toasts that arrived since the last one", () => {
    const notice = createConnectSignInNotice(toasts);
    const states: DesktopConnectSignInState[] = [
      "waiting",
      "waiting",
      "timed-out",
      "waiting",
      "open-failed",
    ];
    for (const state of states) {
      // An unrelated toast arrives in between and takes the front of the stack.
      toasts.shown.unshift(`other-${toasts.shown.length}`);
      notice.show(state);
      expect(isNotice(toasts.shown[0]!)).toBe(true);
      expect(noticesShown()).toHaveLength(1);
    }
    expect(toasts.add.mock.calls.map(([options]) => options.title)).toEqual([
      "Finish signing in in your browser",
      "Finish signing in in your browser",
      "Sign-in didn't finish",
      "Finish signing in in your browser",
      "Couldn't open your browser",
    ]);
    // Every notice has its own id, and the one before it is closed after the
    // new one is in place, so the window is never left without a notice.
    expect(new Set(toasts.add.mock.calls.map(([options]) => options.id)).size).toBe(5);
    expect(toasts.calls).toEqual([
      "add Finish signing in in your browser",
      "add Finish signing in in your browser",
      "close",
      "add Sign-in didn't finish",
      "close",
      "add Finish signing in in your browser",
      "close",
      "add Couldn't open your browser",
      "close",
    ]);
  });

  it.each(["completed", "replaced"] as const)("takes the notice away when %s", (state) => {
    const notice = createConnectSignInNotice(toasts);
    notice.show("waiting");
    notice.show(state);
    expect(toasts.add).toHaveBeenCalledTimes(1);
    expect(toasts.shown).toEqual([]);
    // Nothing to close a second time.
    notice.show(state);
    notice.dismiss();
    expect(toasts.close).toHaveBeenCalledTimes(1);
  });
});

describe("useConnectSignInNotice", () => {
  type Bridge = Parameters<typeof useConnectSignInNotice>[1];
  function Probe({ bridge, signedIn = false }: { bridge: Bridge; signedIn?: boolean }) {
    useConnectSignInNotice(signedIn, bridge);
    return null;
  }

  it("shows what the desktop reports, and stops listening when it unmounts", async () => {
    const { bridge, emit, listeners } = makeBridge();
    await act(async () => {
      renderer = create(<Probe bridge={bridge} />);
    });
    expect(bridge.onConnectSignInState).toHaveBeenCalledTimes(1);
    expect(toasts.add).not.toHaveBeenCalled();

    emit("waiting");
    expect(lastNotice().title).toBe("Finish signing in in your browser");
    expect(noticesShown()).toHaveLength(1);
    emit("completed");
    expect(toasts.shown).toEqual([]);

    emit("waiting");
    await act(async () => renderer!.unmount());
    renderer = undefined;
    expect(listeners.size).toBe(0);
    // No waiting notice is left behind without a listener to clear it.
    expect(toasts.shown).toEqual([]);
  });

  it("takes a failure notice away once the person is signed in another way", async () => {
    const { bridge, emit } = makeBridge();
    await act(async () => {
      renderer = create(<Probe bridge={bridge} />);
    });
    emit("timed-out");
    expect(noticesShown()).toHaveLength(1);

    // A password or a passkey: the desktop never reports `completed` for it.
    await act(async () => renderer!.update(<Probe bridge={bridge} signedIn />));
    expect(toasts.shown).toEqual([]);
  });

  it.each([
    { name: "a plain browser window (no desktop bridge)", bridge: undefined },
    { name: "an older desktop build (no such event)", bridge: {} },
  ])("changes nothing for $name", async ({ bridge }) => {
    await act(async () => {
      renderer = create(<Probe bridge={bridge} />);
    });
    await act(async () => renderer!.update(<Probe bridge={bridge} signedIn />));
    await act(async () => renderer!.unmount());
    renderer = undefined;
    expect(toasts.add).not.toHaveBeenCalled();
    expect(toasts.close).not.toHaveBeenCalled();
  });

  it("reads the bridge from the window by default", async () => {
    const { bridge, emit } = makeBridge();
    vi.stubGlobal("window", { desktopBridge: bridge });
    function DefaultProbe() {
      useConnectSignInNotice();
      return null;
    }
    await act(async () => {
      renderer = create(<DefaultProbe />);
    });
    emit("timed-out");
    expect(lastNotice().title).toBe("Sign-in didn't finish");
  });
});

describe("ElectronManagedAuthShell", () => {
  const shell = (
    <ElectronManagedAuthShell publishableKey="pk_test_fixture">app</ElectronManagedAuthShell>
  );

  it("listens for the desktop's sign-in state and still renders the app", async () => {
    const { bridge, emit } = makeBridge();
    vi.stubGlobal("window", { desktopBridge: bridge });
    await act(async () => {
      renderer = create(shell);
    });
    expect(renderer!.toJSON()).toBe("app");
    expect(bridge.onConnectSignInState).toHaveBeenCalledTimes(1);
    emit("open-failed");
    expect(lastNotice().title).toBe("Couldn't open your browser");
    expect(noticesShown()).toHaveLength(1);

    // Signed in with a password instead: the notice goes with it.
    await act(async () => auth.set(true));
    expect(toasts.shown).toEqual([]);
  });

  it("renders the app the same with no desktop bridge", async () => {
    vi.stubGlobal("window", {});
    await act(async () => {
      renderer = create(shell);
    });
    expect(renderer!.toJSON()).toBe("app");
    expect(toasts.add).not.toHaveBeenCalled();
    expect(toasts.close).not.toHaveBeenCalled();
  });
});
