import { it as effectIt } from "@effect/vitest";
import { managedRelaySessionAtom, RelayAdmin } from "@specweave-studio/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { connectAdminRead, useConnectAdminOwner, useIsConnectAdmin } from "./connectAdminState";

const relay = vi.hoisted(() => ({
  /** What `/v1/admin/me` answers per Clerk token: true, false, or a failure. */
  owners: new Map<string, boolean | "down">(),
  asked: [] as Array<string>,
}));

vi.mock("../lib/runtime", async () => {
  const { RelayAdmin } = await import("@specweave-studio/client-runtime/relay");
  const Context = await import("effect/Context");
  const Effect = await import("effect/Effect");
  const down = () =>
    new RelayAdmin.RelayAdminRequestError({ kind: "unavailable", status: 503, traceId: "t-1" });
  const client = RelayAdmin.RelayAdminClient.of({
    relayUrl: "https://relay.example.test",
    isOwner: ({ clerkToken }) =>
      Effect.suspend(() => {
        relay.asked.push(clerkToken);
        const answer = relay.owners.get(clerkToken) ?? false;
        return answer === "down" ? Effect.fail(down()) : Effect.succeed(answer);
      }),
    overview: () => Effect.fail(down()),
    listAccounts: () => Effect.fail(down()),
    searchAccounts: () => Effect.fail(down()),
    account: () => Effect.fail(down()),
  });
  // The owner check only takes the relay client from the app runtime.
  return {
    runtime: {
      contextEffect: Effect.succeed(Context.make(RelayAdmin.RelayAdminClient, client)),
    },
  };
});

type Token = string | null | "unreadable";

const signIn = (accountId: string, token: Token = `token-of-${accountId}`) =>
  appAtomRegistry.set(managedRelaySessionAtom, {
    accountId,
    readClerkToken: () =>
      token === "unreadable"
        ? Effect.fail({ _tag: "ManagedRelaySessionError", message: "Clerk is down" } as never)
        : Effect.succeed(token),
  });
const signOut = () => appAtomRegistry.set(managedRelaySessionAtom, null);

const seen: { owner: Array<string>; sidebar: Array<boolean>; retry: () => void } = {
  owner: [],
  sidebar: [],
  retry: () => undefined,
};

const notePage = (state: string, retry: () => void) => {
  seen.owner.push(state);
  seen.retry = retry;
};
const noteSidebar = (shown: boolean) => void seen.sidebar.push(shown);

function Page() {
  const owner = useConnectAdminOwner();
  notePage(owner.state, owner.retry);
  return null;
}

function Sidebar() {
  noteSidebar(useIsConnectAdmin());
  return null;
}

let renderer: ReactTestRenderer | null = null;

async function mount() {
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <Sidebar />
        <Page />
      </AppAtomRegistryProvider>,
    );
  });
  // The owner check answers on a later tick.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function settle(change: () => void) {
  await act(async () => {
    change();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  relay.owners.clear();
  relay.asked.length = 0;
  seen.owner.length = 0;
  seen.sidebar.length = 0;
  signOut();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  signOut();
});

describe("who the app shows Connect admin to", () => {
  it("nobody while this window is signed out, and it asks the relay nothing", async () => {
    await mount();
    expect(seen.owner.at(-1)).toBe("not-owner");
    expect(seen.sidebar.at(-1)).toBe(false);
    expect(relay.asked).toEqual([]);
  });

  it("an owner, after one question shared by the sidebar and the page", async () => {
    relay.owners.set("token-of-user_owner_a", true);
    signIn("user_owner_a");
    await mount();
    expect(seen.owner.at(-1)).toBe("owner");
    expect(seen.sidebar.at(-1)).toBe(true);
    // Never shown before the relay answered.
    expect(seen.sidebar.slice(0, -1)).not.toContain(true);
    expect(relay.asked).toEqual(["token-of-user_owner_a"]);

    // Leaving Settings and coming back in the same Connect session asks nothing new.
    act(() => renderer?.unmount());
    await mount();
    expect(seen.owner.at(-1)).toBe("owner");
    expect(relay.asked).toEqual(["token-of-user_owner_a"]);
  });

  it("not an account the relay does not list", async () => {
    relay.owners.set("token-of-user_plain_b", false);
    signIn("user_plain_b");
    await mount();
    expect(seen.owner.at(-1)).toBe("not-owner");
    expect(seen.sidebar).not.toContain(true);
    expect(relay.asked).toEqual(["token-of-user_plain_b"]);
  });

  it("not an account whose check failed, until a retry succeeds", async () => {
    relay.owners.set("token-of-user_owner_c", "down");
    signIn("user_owner_c");
    await mount();
    expect(seen.owner.at(-1)).toBe("failed");
    expect(seen.sidebar).not.toContain(true);

    relay.owners.set("token-of-user_owner_c", true);
    await settle(() => seen.retry());
    expect(seen.owner.at(-1)).toBe("owner");
    expect(seen.sidebar.at(-1)).toBe(true);
    expect(relay.asked).toHaveLength(2);
  });

  it("not a session without a token", async () => {
    signIn("user_owner_d", null);
    await mount();
    expect(seen.owner.at(-1)).toBe("not-owner");
    expect(relay.asked).toEqual([]);
  });

  it("not the next account after an owner signs out or another account signs in", async () => {
    relay.owners.set("token-of-user_owner_e", true);
    signIn("user_owner_e");
    await mount();
    expect(seen.sidebar.at(-1)).toBe(true);

    await settle(signOut);
    expect(seen.owner.at(-1)).toBe("not-owner");
    expect(seen.sidebar.at(-1)).toBe(false);

    seen.sidebar.length = 0;
    await settle(() => signIn("user_plain_f"));
    expect(seen.owner.at(-1)).toBe("not-owner");
    // The other account's "owner" answer never showed for this one.
    expect(seen.sidebar).not.toContain(true);
    expect(relay.asked).toEqual(["token-of-user_owner_e", "token-of-user_plain_f"]);
  });
});

describe("reading through the Connect admin client", () => {
  const unavailable = () =>
    new RelayAdmin.RelayAdminRequestError({ kind: "unavailable", status: 503, traceId: "t-1" });
  const layer = Layer.succeed(
    RelayAdmin.RelayAdminClient,
    RelayAdmin.RelayAdminClient.of({
      relayUrl: "https://relay.example.test",
      isOwner: () => Effect.succeed(true),
      overview: () => Effect.fail(unavailable()),
      listAccounts: () => Effect.fail(unavailable()),
      searchAccounts: () => Effect.fail(unavailable()),
      account: () => Effect.fail(unavailable()),
    }),
  );
  const overview = (client: RelayAdmin.RelayAdminClientShape, clerkToken: string) =>
    client.overview({ clerkToken });

  effectIt.effect("says signed out without a session or without a token", () =>
    Effect.gen(function* () {
      expect(yield* connectAdminRead(overview)).toEqual({
        ok: false,
        failure: { kind: "signed_out", status: null, traceId: null },
      });
      signIn("user_owner_g", null);
      expect(yield* connectAdminRead(overview)).toMatchObject({ failure: { kind: "signed_out" } });
    }).pipe(Effect.provide(layer)),
  );

  effectIt.effect("calls a token that could not be read a failure to retry, not a sign-out", () =>
    Effect.gen(function* () {
      signIn("user_owner_h", "unreadable");
      expect(yield* connectAdminRead(overview)).toEqual({
        ok: false,
        failure: { kind: "session_unread", status: null, traceId: null },
      });
    }).pipe(Effect.provide(layer)),
  );

  effectIt.effect("passes the session's token and returns a relay failure as a value", () =>
    Effect.gen(function* () {
      signIn("user_owner_i");
      const tokens: Array<string> = [];
      const result = yield* connectAdminRead((client, clerkToken) => {
        tokens.push(clerkToken);
        return client.overview({ clerkToken });
      });
      expect(tokens).toEqual(["token-of-user_owner_i"]);
      expect(result).toEqual({
        ok: false,
        failure: { kind: "unavailable", status: 503, traceId: "t-1" },
      });
      expect(yield* connectAdminRead(() => Effect.succeed("answer"))).toEqual({
        ok: true,
        value: "answer",
      });
    }).pipe(Effect.provide(layer)),
  );
});
