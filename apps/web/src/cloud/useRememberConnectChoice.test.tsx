import { act } from "react";
import { create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({ storage: {} as Record<string, unknown> }));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: (key: string, initial: unknown) => [
    runtime.storage[key] ?? initial,
    (next: (state: unknown) => unknown) => {
      runtime.storage[key] = next(runtime.storage[key] ?? initial);
    },
  ],
}));

import { CONNECT_TURNED_OFF_STORAGE_KEY, connectAtSignIn } from "./connectOnboarding";
import { useRememberConnectChoice } from "./useRememberConnectChoice";

async function remember(account: string | null, on: boolean) {
  function Harness() {
    const save = useRememberConnectChoice(account);
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
    wizardOptOutAccounts: [],
    phoneCardPending: false,
  });

describe("the Settings switch for SpecWithCode Connect", () => {
  beforeEach(() => {
    runtime.storage = {};
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
});
