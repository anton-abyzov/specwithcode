import type { DesktopConnectSignInState } from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => ({
  add: vi.fn((_options: Record<string, unknown>) => "connect-sign-in"),
  close: vi.fn((_id?: string) => undefined),
}));
vi.mock("../ui/toast", () => ({ toastManager: toasts }));
vi.mock("@clerk/electron/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@clerk/electron/passkeys", () => ({ passkeys: {} }));
vi.mock("../../cloud/managedAuth", () => ({
  ManagedRelayAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./clerkAppearance", () => ({ clerkAppearance: {} }));

import ElectronManagedAuthShell from "./ElectronManagedAuthShell";
import {
  CONNECT_SIGN_IN_NOTICE_ID,
  showConnectSignInState,
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
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const lastNotice = () => toasts.add.mock.calls.at(-1)![0];

describe("showConnectSignInState", () => {
  it("says the sign-in continues in the browser and where to look", () => {
    showConnectSignInState("waiting");
    expect(toasts.add.mock.calls).toEqual([
      [
        {
          id: CONNECT_SIGN_IN_NOTICE_ID,
          type: "loading",
          title: "Finish signing in in your browser",
          description:
            "The sign-in page opened in your browser. If you don't see it, look for a new browser tab or window. Click the button again to open it again.",
          timeout: 0,
          data: { aboveSignInDialog: true, hideCopyButton: true },
        },
      ],
    ]);
  });

  it("says the browser could not be opened and what to do", () => {
    showConnectSignInState("open-failed");
    expect(lastNotice()).toMatchObject({
      id: CONNECT_SIGN_IN_NOTICE_ID,
      type: "error",
      title: "Couldn't open your browser",
      description: "Open a browser on this computer, then click the button again.",
      timeout: 0,
    });
  });

  it("says the sign-in did not finish and that clicking again retries", () => {
    showConnectSignInState("timed-out");
    expect(lastNotice()).toMatchObject({
      id: CONNECT_SIGN_IN_NOTICE_ID,
      type: "warning",
      title: "Sign-in didn't finish",
      description:
        "The browser didn't come back within 3 minutes. Click the button again to retry.",
      timeout: 0,
    });
  });

  it("keeps one notice: every state lands on the same toast id, so it is replaced in place", () => {
    const states: DesktopConnectSignInState[] = [
      "waiting",
      "waiting",
      "timed-out",
      "waiting",
      "open-failed",
    ];
    for (const state of states) showConnectSignInState(state);
    expect(toasts.add.mock.calls.map(([options]) => [options.id, options.title])).toEqual([
      [CONNECT_SIGN_IN_NOTICE_ID, "Finish signing in in your browser"],
      [CONNECT_SIGN_IN_NOTICE_ID, "Finish signing in in your browser"],
      [CONNECT_SIGN_IN_NOTICE_ID, "Sign-in didn't finish"],
      [CONNECT_SIGN_IN_NOTICE_ID, "Finish signing in in your browser"],
      [CONNECT_SIGN_IN_NOTICE_ID, "Couldn't open your browser"],
    ]);
    expect(toasts.close).not.toHaveBeenCalled();
  });

  it.each(["completed", "replaced"] as const)("takes the notice away when %s", (state) => {
    showConnectSignInState("waiting");
    showConnectSignInState(state);
    expect(toasts.add).toHaveBeenCalledTimes(1);
    expect(toasts.close.mock.calls).toEqual([[CONNECT_SIGN_IN_NOTICE_ID]]);
  });
});

describe("useConnectSignInNotice", () => {
  function Probe({ bridge }: { bridge: Parameters<typeof useConnectSignInNotice>[0] }) {
    useConnectSignInNotice(bridge);
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
    emit("completed");
    expect(toasts.close.mock.calls).toEqual([[CONNECT_SIGN_IN_NOTICE_ID]]);

    emit("waiting");
    await act(async () => renderer!.unmount());
    renderer = undefined;
    expect(listeners.size).toBe(0);
    // No waiting notice is left behind without a listener to clear it.
    expect(toasts.close.mock.calls).toEqual([
      [CONNECT_SIGN_IN_NOTICE_ID],
      [CONNECT_SIGN_IN_NOTICE_ID],
    ]);
  });

  it.each([
    { name: "a plain browser window (no desktop bridge)", bridge: undefined },
    { name: "an older desktop build (no such event)", bridge: {} },
  ])("changes nothing for $name", async ({ bridge }) => {
    await act(async () => {
      renderer = create(<Probe bridge={bridge} />);
    });
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
  it("listens for the desktop's sign-in state and still renders the app", async () => {
    const { bridge, emit } = makeBridge();
    vi.stubGlobal("window", { desktopBridge: bridge });
    await act(async () => {
      renderer = create(
        <ElectronManagedAuthShell publishableKey="pk_test_fixture">app</ElectronManagedAuthShell>,
      );
    });
    expect(renderer!.toJSON()).toBe("app");
    expect(bridge.onConnectSignInState).toHaveBeenCalledTimes(1);
    emit("open-failed");
    expect(lastNotice().title).toBe("Couldn't open your browser");
  });
});
