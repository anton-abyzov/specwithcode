import { act } from "react";
import { create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  storage: {} as Record<string, unknown>,
  auth: { isSignedIn: false, userId: null } as { isSignedIn: boolean; userId: string | null },
  authOptions: [] as unknown[],
}));
vi.mock("@clerk/react", () => ({
  useAuth: (options: unknown) => {
    runtime.authOptions.push(options);
    return runtime.auth;
  },
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: (key: string) => runtime.storage[key] ?? null,
  setLocalStorageItem: (key: string, value: unknown) => {
    runtime.storage[key] = value;
  },
  useLocalStorage: (key: string, initial: unknown) => [
    runtime.storage[key] ?? initial,
    (next: (state: unknown) => unknown) => {
      runtime.storage[key] = next(runtime.storage[key] ?? initial);
    },
  ],
}));

import {
  CONNECT_ACCOUNT_AUTH,
  CONNECT_TURNED_OFF_STORAGE_KEY,
  connectAtSignIn,
} from "./connectOnboarding";
import { useRememberConnectChoice } from "./useRememberConnectChoice";

/** The switch is used by whoever Clerk says is signed in; null is signed out. */
async function remember(account: string | null, on: boolean) {
  runtime.auth = { isSignedIn: account !== null, userId: account };
  function Harness() {
    const save = useRememberConnectChoice();
    save(on);
    return null;
  }
  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => renderer!.unmount());
}
const turnedOff = () =>
  (runtime.storage[CONNECT_TURNED_OFF_STORAGE_KEY] as { accounts: string[] } | undefined)
    ?.accounts ?? [];
const nextSignIn = (account: string) =>
  connectAtSignIn({
    account,
    desktopApp: true,
    sessionKnown: true,
    canManageLink: true,
    rulesKnown: true,
    rulesLockConnect: false,
    linkState: { linked: false },
    linkStatePending: false,
    linkStateFailed: false,
    turnedOffAccounts: turnedOff(),
    turnedOffUnreadable: false,
    wizardOptOutAccounts: [],
    phoneCardPending: false,
  });

describe("the Settings switch for SpecWithCode Connect", () => {
  beforeEach(() => {
    runtime.storage = {};
    runtime.authOptions = [];
  });
  it("turned off, holds the next sign-in of that account back", async () => {
    await remember("user_a", false);
    expect(turnedOff()).toEqual(["user_a"]);
    expect(nextSignIn("user_a")).toBe("skip");
    expect(nextSignIn("user_b")).toBe("turn-on");
  });
  it("turned on again, lets a sign-in turn it on as before", async () => {
    await remember("user_a", false);
    await remember("user_a", true);
    expect(turnedOff()).toEqual([]);
    expect(nextSignIn("user_a")).toBe("turn-on");
  });
  it("saves nothing while signed out", async () => {
    await remember(null, false);
    expect(turnedOff()).toEqual([]);
  });
  it("reads the account the way the sign-in wizard does, so a pending session's choice is saved", async () => {
    // With a pending session Clerk reports the account only under this option;
    // the default would say signed out and the off choice would be dropped.
    await remember("user_a", false);
    expect(runtime.authOptions).toEqual([{ treatPendingAsSignedOut: false }]);
    expect(runtime.authOptions[0]).toBe(CONNECT_ACCOUNT_AUTH);
    expect(turnedOff()).toEqual(["user_a"]);
  });
  it("saves nothing for a session whose account Clerk has not filled in yet", async () => {
    runtime.auth = { isSignedIn: true, userId: null };
    function Harness() {
      useRememberConnectChoice()(false);
      return null;
    }
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => renderer!.unmount());
    expect(turnedOff()).toEqual([]);
  });
});
