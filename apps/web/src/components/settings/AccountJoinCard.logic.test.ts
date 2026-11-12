import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canChooseJoinCardMachine,
  EMPTY_JOIN_CARD_FOLDED_STATE,
  joinCardConnect,
  joinCardMachines,
  platformName,
  withJoinCardFolded,
} from "./AccountJoinCard.logic";

const m1 = EnvironmentId.make("m1");
const m5 = EnvironmentId.make("m5");
const name = (_id: EnvironmentId, label: string) => label;

describe("joinCardMachines", () => {
  it("lists saved machines first, then the account's machines this app has not opened", () => {
    const machines = joinCardMachines({
      saved: [{ environmentId: m1, label: "M1", connected: true, facts: null }],
      discovered: [{ environmentId: m5, label: "M5", availability: "online", facts: null }],
      accountOnly: [m5],
      name,
    });
    expect(
      machines.map((machine) => [machine.environmentId, machine.accountOnly, machine.onAccount]),
    ).toEqual([
      ["m1", false, false],
      ["m5", true, true],
    ]);
  });

  it("still counts a machine as the account's once this app has opened it", () => {
    const [machine] = joinCardMachines({
      saved: [{ environmentId: m5, label: "M5", connected: true, facts: null }],
      discovered: [{ environmentId: m5, label: "M5", availability: "online", facts: null }],
      accountOnly: [],
      name,
    });
    expect([machine?.accountOnly, machine?.onAccount]).toEqual([false, true]);
  });

  it("shows the name the owner gave a machine", () => {
    const [machine] = joinCardMachines({
      saved: [],
      discovered: [
        { environmentId: m5, label: "MacBook Pro (2)", availability: "online", facts: null },
      ],
      accountOnly: [m5],
      name: () => "Travel laptop",
    });
    expect(machine?.label).toBe("Travel laptop");
  });

  it("takes this app's own connection over the account's last answer", () => {
    const state = (
      connected: boolean,
      availability?: "checking" | "online" | "offline" | "error",
    ) =>
      joinCardMachines({
        saved: [{ environmentId: m1, label: "M1", connected, facts: null }],
        discovered: availability
          ? [{ environmentId: m1, label: "M1", availability, facts: null }]
          : [],
        accountOnly: [],
        name,
      })[0]?.state;
    expect(state(true, "offline")).toBe("online");
    expect(state(false, "online")).toBe("online");
    expect(state(false, "checking")).toBe("checking");
    expect(state(false, "offline")).toBe("not-answering");
    expect(state(false, "error")).toBe("not-answering");
    // Saved here, not connected, and not on the account: the app cannot say more.
    expect(state(false)).toBe("not-connected");
  });

  it("shows the operating system and version only when the machine reported them", () => {
    const [reported, silent] = joinCardMachines({
      saved: [
        {
          environmentId: m1,
          label: "M1",
          connected: true,
          facts: { platform: { os: "windows" }, serverVersion: "1.0.243" },
        },
      ],
      discovered: [{ environmentId: m5, label: "M5", availability: "online", facts: null }],
      accountOnly: [m5],
      name,
    });
    expect([reported?.os, reported?.version]).toEqual(["Windows", "1.0.243"]);
    expect([silent?.os, silent?.version]).toEqual([null, null]);
  });

  it("falls back to what the account read for a saved machine with no facts of its own", () => {
    const [machine] = joinCardMachines({
      saved: [{ environmentId: m1, label: "M1", connected: false, facts: null }],
      discovered: [
        {
          environmentId: m1,
          label: "M1",
          availability: "online",
          facts: { platform: { os: "linux" }, serverVersion: "1.0.240" },
        },
      ],
      accountOnly: [],
      name,
    });
    expect([machine?.os, machine?.version]).toEqual(["Linux", "1.0.240"]);
  });

  it("leaves out an account machine the discovery no longer lists", () => {
    expect(joinCardMachines({ saved: [], discovered: [], accountOnly: [m5], name })).toEqual([]);
  });
});

describe("platformName", () => {
  it("names the systems SpecWithCode runs on and nothing else", () => {
    expect(["darwin", "linux", "windows"].map(platformName)).toEqual(["macOS", "Linux", "Windows"]);
    expect(platformName("freebsd")).toBeNull();
    expect(platformName(undefined)).toBeNull();
  });
});

describe("canChooseJoinCardMachine", () => {
  it("refuses only a machine that is not answering", () => {
    const can = (state: "online" | "checking" | "not-answering" | "not-connected") =>
      canChooseJoinCardMachine({
        environmentId: m1,
        label: "M1",
        state,
        os: null,
        version: null,
        accountOnly: true,
        onAccount: true,
      });
    expect(can("online")).toBe(true);
    expect(can("checking")).toBe(true);
    expect(can("not-connected")).toBe(true);
    expect(can("not-answering")).toBe(false);
  });
});

describe("withJoinCardFolded", () => {
  it("folds and reopens one machine's card without touching another's", () => {
    const folded = withJoinCardFolded({ environments: ["other"] }, "m4", true);
    expect(folded).toEqual({ environments: ["other", "m4"] });
    expect(withJoinCardFolded(folded, "m4", false)).toEqual({ environments: ["other"] });
  });

  it("keeps the same value when nothing changes", () => {
    expect(withJoinCardFolded(EMPTY_JOIN_CARD_FOLDED_STATE, "m4", false)).toBe(
      EMPTY_JOIN_CARD_FOLDED_STATE,
    );
    const folded = { environments: ["m4"] };
    expect(withJoinCardFolded(folded, "m4", true)).toBe(folded);
  });
});

describe("joinCardConnect", () => {
  const link = { linked: true, managedTunnelActive: true };
  it("waits for the sign-in before saying anything", () => {
    expect(joinCardConnect({ loaded: false, signedIn: false, account: null, link: null })).toEqual({
      kind: "loading",
    });
  });

  it("says signed out only once the sign-in is read", () => {
    expect(joinCardConnect({ loaded: true, signedIn: false, account: null, link })).toEqual({
      kind: "signed-out",
    });
  });

  it("carries the account and whether other machines can reach this one", () => {
    const signedIn = { loaded: true, signedIn: true, account: "anton@example.com" };
    expect(joinCardConnect({ ...signedIn, link })).toEqual({
      kind: "signed-in",
      account: "anton@example.com",
      connectOn: true,
    });
    // Linked for activity only: no address other machines can reach.
    expect(
      joinCardConnect({ ...signedIn, link: { linked: true, managedTunnelActive: false } }),
    ).toMatchObject({ connectOn: false });
    // An older server reports only whether it is linked.
    expect(joinCardConnect({ ...signedIn, link: { linked: true } })).toMatchObject({
      connectOn: true,
    });
    expect(joinCardConnect({ ...signedIn, link: { linked: false } })).toMatchObject({
      connectOn: false,
    });
    // Unread or unreadable: unknown, so the card claims nothing.
    expect(joinCardConnect({ ...signedIn, link: null })).toMatchObject({ connectOn: null });
  });
});
