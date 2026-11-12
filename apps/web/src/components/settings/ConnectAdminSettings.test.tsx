import type {
  RelayAdminAccount,
  RelayAdminAccountResponse,
  RelayAdminAccountsResponse,
  RelayAdminMachine,
  RelayAdminOverviewResponse,
} from "@specweave-studio/contracts/relayAdmin";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ConnectAdminFailure, ConnectAdminRead } from "~/cloud/connectAdminState";
import { englishPhrase } from "../../i18n";
import { ConnectAdminSettings } from "./ConnectAdminSettings";
import {
  accountListOf,
  accountSubtitle,
  appendAccountPage,
  failureCopy,
  failureIsFinal,
  formatAdminTime,
  machineLimitText,
  machineState,
  overviewTiles,
} from "./ConnectAdminSettings.logic";

type Call =
  | { readonly kind: "overview" }
  | { readonly kind: "list"; readonly cursor?: string }
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "account"; readonly userId: string };

const state = vi.hoisted(() => ({
  owner: "owner" as "checking" | "owner" | "not-owner" | "failed",
  retryOwner: vi.fn(),
  calls: [] as Array<unknown>,
  answer: (_call: unknown): unknown => undefined,
}));

vi.mock("~/cloud/connectAdminState", () => ({
  useConnectAdminOwner: () => ({ state: state.owner, retry: state.retryOwner }),
  readConnectAdmin: (
    read: (client: unknown, clerkToken: string) => unknown,
  ): Promise<ConnectAdminRead<unknown>> => {
    const record = (call: Call) => {
      state.calls.push(call);
      return call;
    };
    const client = {
      overview: () => record({ kind: "overview" }),
      listAccounts: (input: { cursor?: string }) =>
        record(
          input.cursor === undefined ? { kind: "list" } : { kind: "list", cursor: input.cursor },
        ),
      searchAccounts: (input: { query: string }) => record({ kind: "search", query: input.query }),
      account: (input: { userId: string }) => record({ kind: "account", userId: input.userId }),
    };
    return Promise.resolve(state.answer(read(client, "clerk-token")) as ConnectAdminRead<unknown>);
  },
}));
vi.mock("./settingsLayout", async (original) => ({
  ...(await original<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const ok = <A,>(value: A): ConnectAdminRead<A> => ({ ok: true, value });
const fail = (kind: ConnectAdminFailure["kind"], status: number | null = null) => ({
  ok: false as const,
  failure: { kind, status, traceId: status === 503 ? "trace-503" : null },
});

const overview: RelayAdminOverviewResponse = {
  accounts: 3,
  linkedMachines: 5,
  tunnelsAllocated: 4,
  tunnelsReady: 2,
  phones: 1,
  founderSeatsGranted: 7,
  founderSeatCap: 300,
  freeMachineLimit: 2,
  globalTunnelCap: null,
};

const account = (
  userId: string,
  overrides: Partial<RelayAdminAccount> = {},
): RelayAdminAccount => ({
  userId,
  email: `${userId}@example.test`,
  name: `Person ${userId}`,
  founderNumber: null,
  limit: { maxMachines: 2, source: "free" },
  machineCount: 1,
  phoneCount: 0,
  firstSeenAt: "2026-11-01T10:00:00.000Z",
  lastSeenAt: "2026-11-10T10:00:00.000Z",
  ...overrides,
});

const page = (
  accounts: ReadonlyArray<RelayAdminAccount>,
  overrides: Partial<RelayAdminAccountsResponse> = {},
): RelayAdminAccountsResponse => ({
  accounts,
  nextCursor: null,
  identities: "read",
  searchTruncated: false,
  ...overrides,
});

const machine = (overrides: Partial<RelayAdminMachine> = {}): RelayAdminMachine => ({
  environmentId: "env-1",
  label: "Studio Mac",
  hostname: "abc.connect.example.test",
  linkedAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-09T10:00:00.000Z",
  unlinkedAt: null,
  tunnel: "ready",
  live: "healthy",
  liveChangedAt: null,
  ...overrides,
});

const detailOf = (user: RelayAdminAccount): RelayAdminAccountResponse => ({
  account: user,
  machines: [machine(), machine({ environmentId: "env-2", label: "Old PC", live: "down" })],
  phones: [
    {
      deviceId: "phone-1",
      label: "Pocket",
      platform: "ios",
      model: "iPhone 16",
      appVersion: "0.1.1",
      lastSeenAt: null,
    },
  ],
});

let renderer: ReactTestRenderer | null = null;

async function mount() {
  await act(async () => {
    renderer = create(<ConnectAdminSettings />);
  });
  return renderer!;
}

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const pageText = () => textOf(renderer!.root);
const buttons = (label: string) =>
  renderer!.root.findAll((node) => node.type === "button" && textOf(node).includes(label));
const press = async (label: string, index = 0) => {
  await act(async () => {
    buttons(label)[index]!.props.onClick();
  });
};

beforeEach(() => {
  state.owner = "owner";
  state.calls = [];
  state.retryOwner.mockClear();
  state.answer = (call) => {
    const { kind } = call as Call;
    if (kind === "overview") return ok(overview);
    if (kind === "account") return ok(detailOf(account("user_a")));
    return ok(page([account("user_a"), account("user_b")]));
  };
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("ConnectAdminSettings", () => {
  it("shows nothing of the page and asks the relay nothing for a non-owner", async () => {
    state.owner = "not-owner";
    await mount();
    expect(pageText()).toContain("This page is only for the owners of SpecWithCode Connect.");
    expect(state.calls).toEqual([]);
  });

  it("offers a retry when the owner check could not be made", async () => {
    state.owner = "failed";
    await mount();
    expect(pageText()).toContain("Could not check whether this account is an owner.");
    await press("Try again");
    expect(state.retryOwner).toHaveBeenCalledTimes(1);
    expect(state.calls).toEqual([]);
  });

  it("shows the totals and the newest accounts for an owner", async () => {
    await mount();
    expect(state.calls).toEqual([{ kind: "overview" }, { kind: "list" }]);
    const text = pageText();
    expect(text).toContain("Linked machines5");
    expect(text).toContain("Tunnels ready / allocated2 / 4");
    expect(text).toContain("Founder seats taken7 / 300");
    expect(text).toContain("Tunnel cap for all accountsNo cap");
    expect(text).toContain("Person user_a");
    expect(text).toContain("user_a@example.test · user_a");
    expect(text).toContain("Machines: 1 · Phones: 0 · Machine limit: 2, free plan");
  });

  it("says a failed list failed, never that there are no accounts, and retries", async () => {
    state.answer = (call) =>
      (call as Call).kind === "overview" ? ok(overview) : fail("unavailable", 503);
    await mount();
    expect(pageText()).toContain("SpecWithCode Connect could not read its data");
    expect(pageText()).toContain("HTTP 503 · trace trace-503");
    expect(pageText()).not.toContain("No one has signed in");

    state.answer = (call) =>
      (call as Call).kind === "overview" ? ok(overview) : ok(page([account("user_a")]));
    await press("Try again");
    expect(pageText()).toContain("Person user_a");
    expect(pageText()).not.toContain("could not read its data");
  });

  it("offers no retry once the relay says this account is not an owner", async () => {
    state.answer = () => fail("not_owner", 404);
    await mount();
    expect(pageText()).toContain("This account is not a Connect owner");
    expect(buttons("Try again")).toHaveLength(0);
  });

  it("says so when no one has used Connect", async () => {
    state.answer = (call) => ((call as Call).kind === "overview" ? ok(overview) : ok(page([])));
    await mount();
    expect(pageText()).toContain("No one has signed in to SpecWithCode Connect yet.");
  });

  it("searches on submit, warns about a cut-off answer and returns to the list", async () => {
    await mount();
    const input = renderer!.root.findByProps({ type: "search" });
    await act(async () => {
      input.props.onChange({ target: { value: "  person@example.test " } });
    });
    state.answer = (call) =>
      (call as Call).kind === "search"
        ? ok(page([account("user_b")], { searchTruncated: true, identities: "unavailable" }))
        : ok(page([account("user_a")]));
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
    });
    expect(state.calls.at(-1)).toEqual({ kind: "search", query: "person@example.test" });
    expect(pageText()).toContain("More accounts match than are shown. Narrow the search.");
    expect(pageText()).toContain("Names and emails could not be read from Clerk.");
    expect(pageText()).not.toContain("Person user_a");

    await press("Show all");
    expect(state.calls.at(-1)).toEqual({ kind: "list" });
    expect(pageText()).toContain("Person user_a");
  });

  it("tells an empty search from an empty list", async () => {
    await mount();
    await act(async () => {
      renderer!.root.findByProps({ type: "search" }).props.onChange({ target: { value: "zz" } });
    });
    state.answer = () => ok(page([]));
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
    });
    expect(pageText()).toContain("No account matches that search.");
  });

  it("loads the next page after the ones on screen and keeps them on a failure", async () => {
    state.answer = (call) => {
      const read = call as Call;
      if (read.kind === "overview") return ok(overview);
      if (read.kind === "list" && read.cursor === "next-1") return fail("timeout");
      return ok(page([account("user_a")], { nextCursor: "next-1" }));
    };
    await mount();
    await press("Load more");
    expect(state.calls.at(-1)).toEqual({ kind: "list", cursor: "next-1" });
    expect(pageText()).toContain("SpecWithCode Connect did not answer in time");
    expect(pageText()).toContain("Person user_a");

    state.answer = () => ok(page([account("user_c")]));
    await press("Try again");
    expect(pageText()).toContain("Person user_a");
    expect(pageText()).toContain("Person user_c");
    expect(buttons("Load more")).toHaveLength(0);
  });

  it("opens one account's machines and phones in plain words", async () => {
    await mount();
    await press("Person user_a");
    expect(state.calls.at(-1)).toEqual({ kind: "account", userId: "user_a" });
    const text = pageText();
    expect(text).toContain("Studio MacOnline");
    expect(text).toContain("Old PCOffline: the tunnel is down");
    expect(text).toContain("abc.connect.example.test");
    expect(text).toContain("Pocket");
    expect(text).toContain("iOS · iPhone 16 · App 0.1.1 · Never seen");
    expect(buttons("Person user_a")[0]!.props["aria-expanded"]).toBe(true);

    await press("Person user_a");
    expect(pageText()).not.toContain("Studio Mac");
  });

  it("says a failed account read failed and retries it", async () => {
    state.answer = (call) => {
      const read = call as Call;
      if (read.kind === "overview") return ok(overview);
      if (read.kind === "account") return fail("network");
      return ok(page([account("user_a")]));
    };
    await mount();
    await press("Person user_a");
    expect(pageText()).toContain("Could not reach SpecWithCode Connect");
    expect(pageText()).not.toContain("No machine has been linked");

    state.answer = () => ok({ ...detailOf(account("user_a")), machines: [], phones: [] });
    await press("Try again");
    expect(pageText()).toContain("No machine has been linked to this account.");
    expect(pageText()).toContain("No phone is signed in to this account.");
  });

  it("refreshes the totals, the list and the open account in place", async () => {
    await mount();
    await press("Person user_a");
    state.calls = [];
    // The new answers arrive later: what is on screen stays until then.
    const pending: Array<() => void> = [];
    const answer = state.answer;
    state.answer = (call) =>
      new Promise((resolve) => {
        pending.push(() => resolve(answer(call)));
      });
    await press("Refresh");
    expect(state.calls).toEqual([
      { kind: "overview" },
      { kind: "list" },
      { kind: "account", userId: "user_a" },
    ]);
    expect(pageText()).toContain("Person user_a");
    expect(pageText()).toContain("Studio Mac");
    expect(pageText()).not.toContain("Loading accounts…");
    expect(buttons("Refresh")[0]!.props.disabled).toBe(true);

    await act(async () => {
      for (const release of pending) release();
    });
    expect(buttons("Refresh")[0]!.props.disabled).toBe(false);
    expect(pageText()).toContain("Studio Mac");
  });
});

describe("Connect admin page logic", () => {
  const tx = englishPhrase;

  it("names every machine state", () => {
    const states = (
      [
        [{ unlinkedAt: "2026-11-05T00:00:00.000Z" }, "Unlinked", "outline"],
        [{ tunnel: "none" }, "Linked without a Connect tunnel", "outline"],
        [{ tunnel: "provisioning" }, "Tunnel is being set up", "warning"],
        [{ tunnel: "released" }, "Offline: the machine gave its tunnel back", "outline"],
        [{ live: "healthy" }, "Online", "success"],
        [{ live: "degraded" }, "Online, connection degraded", "warning"],
        [{ live: "down" }, "Offline: the tunnel is down", "error"],
        [{ live: "inactive" }, "Offline: the tunnel never connected", "outline"],
        [{ live: "unknown" }, "Tunnel ready, live status not read", "outline"],
      ] as const
    ).map(([overrides, phrase, tone]) => [machineState(machine(overrides)), { phrase, tone }]);
    for (const [actual, expected] of states) expect(actual).toEqual(expected);
  });

  it("says where a machine limit comes from", () => {
    expect(machineLimitText(tx, { maxMachines: 2, source: "free" })).toBe(
      "Machine limit: 2, free plan",
    );
    expect(machineLimitText(tx, { maxMachines: 10, source: "founder" })).toBe(
      "Machine limit: 10, founder",
    );
    expect(machineLimitText(tx, { maxMachines: 0, source: "override" })).toBe(
      "Machine limit: 0, set by an owner",
    );
    expect(machineLimitText(tx, { maxMachines: null, source: "override" })).toBe(
      "No machine limit, set by an owner",
    );
    expect(machineLimitText(tx, { maxMachines: null, source: "free" })).toBe("No machine limit");
  });

  it("shows only the id when Clerk gave no identity", () => {
    expect(accountSubtitle(account("user_a"))).toBe("user_a@example.test · user_a");
    expect(accountSubtitle(account("user_a", { name: null }))).toBe("user_a");
    expect(accountSubtitle(account("user_a", { name: null, email: null }))).toBe("");
  });

  it("appends a page without repeating an account that moved", () => {
    const first = accountListOf(page([account("user_a"), account("user_b")], { nextCursor: "n" }));
    const merged = appendAccountPage(
      first,
      page([account("user_b", { machineCount: 4 }), account("user_c")], {
        identities: "unavailable",
      }),
    );
    expect(merged.accounts.map((entry) => [entry.userId, entry.machineCount])).toEqual([
      ["user_a", 1],
      ["user_b", 4],
      ["user_c", 1],
    ]);
    expect(merged.nextCursor).toBeNull();
    expect(merged.identitiesRead).toBe(false);
  });

  it("has copy for every failure and retries only what a retry can fix", () => {
    const kinds = [
      "signed_out",
      "not_owner",
      "account_not_found",
      "unavailable",
      "timeout",
      "network",
      "failed",
    ] as const;
    for (const kind of kinds) {
      const copy = failureCopy({ kind, status: null, traceId: null });
      expect(copy.title.length, kind).toBeGreaterThan(0);
      expect(copy.description.length, kind).toBeGreaterThan(0);
    }
    expect(kinds.filter((kind) => failureIsFinal({ kind, status: null, traceId: null }))).toEqual([
      "signed_out",
      "not_owner",
    ]);
  });

  it("shows a set tunnel cap as a number", () => {
    const tiles = overviewTiles(tx, { ...overview, globalTunnelCap: 250 });
    expect(tiles.at(-1)).toEqual({ label: "Tunnel cap for all accounts", value: "250" });
    expect(tiles).toHaveLength(7);
  });

  it("formats a time for the reader and leaves text that is not a date", () => {
    expect(formatAdminTime("2026-11-10T10:05:00.000Z", "en-US", "UTC")).toBe(
      "Nov 10, 2026, 10:05 AM",
    );
    expect(formatAdminTime("not a date", "en-US", "UTC")).toBe("not a date");
  });
});
