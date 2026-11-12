import type {
  RelayAdminAccount,
  RelayAdminAccountResponse,
  RelayAdminAction,
  RelayAdminMachine,
} from "@specweave-studio/contracts/relayAdmin";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ConnectAdminFailure, ConnectAdminRead } from "~/cloud/connectAdminState";
import { englishPhrase } from "../../i18n";
import { RadioGroup } from "../ui/radio-group";
import { ConnectAdminSettings } from "./ConnectAdminSettings";
import {
  actionOutcome,
  actionText,
  changeFailureCopy,
  machineLimitDraftOf,
  machineLimitSettingOf,
  withAccount,
} from "./ConnectAdminSettings.logic";

type Call =
  | { readonly kind: "overview" }
  | { readonly kind: "list" }
  | { readonly kind: "account"; readonly userId: string }
  | { readonly kind: "actions" }
  | { readonly kind: "limit"; readonly userId: string; readonly limit: unknown }
  | { readonly kind: "unlink"; readonly userId: string; readonly environmentId: string }
  | { readonly kind: "remove-phone"; readonly userId: string; readonly deviceId: string };

const state = vi.hoisted(() => ({
  calls: [] as Array<unknown>,
  answer: (_call: unknown): unknown => undefined,
  closeDialog: (): void => undefined,
}));

vi.mock("~/cloud/connectAdminState", () => ({
  useConnectAdminOwner: () => ({ state: "owner", retry: () => undefined }),
  readConnectAdmin: (
    read: (client: unknown, clerkToken: string) => unknown,
  ): Promise<ConnectAdminRead<unknown>> => {
    const record = (call: Call) => {
      state.calls.push(call);
      return call;
    };
    const client = {
      overview: () => record({ kind: "overview" }),
      listAccounts: () => record({ kind: "list" }),
      account: (input: { userId: string }) => record({ kind: "account", userId: input.userId }),
      listActions: () => record({ kind: "actions" }),
      setMachineLimit: (input: { userId: string; limit: unknown }) =>
        record({ kind: "limit", userId: input.userId, limit: input.limit }),
      unlinkMachine: (input: { userId: string; environmentId: string }) =>
        record({ kind: "unlink", userId: input.userId, environmentId: input.environmentId }),
      removePhone: (input: { userId: string; deviceId: string }) =>
        record({ kind: "remove-phone", userId: input.userId, deviceId: input.deviceId }),
    };
    return Promise.resolve(state.answer(read(client, "clerk-token")) as ConnectAdminRead<unknown>);
  },
}));
vi.mock("./settingsLayout", async (original) => ({
  ...(await original<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    state.closeDialog = () => onOpenChange(false);
    return open ? <div role="alertdialog">{children}</div> : null;
  },
  AlertDialogPopup: ({ children }: { children: ReactNode }) => children,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => children,
  AlertDialogClose: ({ children }: { children: ReactNode }) => (
    <button onClick={() => state.closeDialog()}>{children}</button>
  ),
}));
vi.mock("../ui/radio-group", () => ({
  RadioGroup: ({ children, value }: { children: ReactNode; value: string }) => (
    <div role="radiogroup" data-value={value}>
      {children}
    </div>
  ),
  Radio: ({ value }: { value: string }) => <span data-radio={value} />,
}));

const ok = <A,>(value: A): ConnectAdminRead<A> => ({ ok: true, value });
const fail = (kind: ConnectAdminFailure["kind"], status: number | null = null) => ({
  ok: false as const,
  failure: { kind, status, traceId: status === 503 ? "trace-503" : null },
});

const overview = {
  accounts: 1,
  linkedMachines: 2,
  tunnelsAllocated: 2,
  tunnelsReady: 2,
  phones: 1,
  founderSeatsGranted: 0,
  founderSeatCap: 300,
  freeMachineLimit: 2,
  globalTunnelCap: null,
};

const account = (overrides: Partial<RelayAdminAccount> = {}): RelayAdminAccount => ({
  userId: "user_a",
  email: "a@example.test",
  name: "Person A",
  founderNumber: null,
  limit: { maxMachines: 2, source: "free" },
  machineCount: 2,
  phoneCount: 1,
  firstSeenAt: "2026-11-01T10:00:00.000Z",
  lastSeenAt: "2026-11-10T10:00:00.000Z",
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
  machines: [
    machine(),
    machine({ environmentId: "env-2", label: "Old PC", unlinkedAt: "2026-11-05T10:00:00.000Z" }),
  ],
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

const recorded = (overrides: Partial<RelayAdminAction> = {}): RelayAdminAction => ({
  id: "rec-1",
  ownerUserId: "user_owner",
  action: "unlink_machine",
  targetUserId: "user_a",
  targetId: "env-1",
  targetLabel: "Studio Mac",
  limitBefore: null,
  limitSet: null,
  outcome: "done",
  createdAt: "2026-11-11T10:00:00.000Z",
  ...overrides,
});

let renderer: ReactTestRenderer | null = null;
let shown = account();
let actions: ReadonlyArray<RelayAdminAction> = [];
/** What a change answers; reads always answer from `shown` and `actions`. */
let changeAnswer: (call: Call) => unknown = () => ok({});

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const pageText = () => textOf(renderer!.root);
const dialog = () => renderer!.root.findAll((node) => node.props.role === "alertdialog")[0];
const dialogText = () => {
  const node = dialog();
  return node === undefined ? null : textOf(node);
};
const buttons = (label: string, within: ReactTestInstance = renderer!.root) =>
  within.findAll((node) => node.type === "button" && textOf(node) === label);
const press = async (label: string, within?: ReactTestInstance) => {
  await act(async () => {
    buttons(label, within)[0]!.props.onClick();
  });
};
const changes = () =>
  state.calls.filter((call) =>
    ["limit", "unlink", "remove-phone"].includes((call as Call).kind),
  ) as ReadonlyArray<Call>;
const count = (kind: Call["kind"]) =>
  state.calls.filter((call) => (call as Call).kind === kind).length;

async function openAccount() {
  await act(async () => {
    renderer = create(<ConnectAdminSettings />);
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-expanded": false }).props.onClick();
  });
}

beforeEach(() => {
  state.calls = [];
  shown = account();
  actions = [];
  changeAnswer = () => ok({});
  state.answer = (call) => {
    const typed = call as Call;
    if (typed.kind === "overview") return ok(overview);
    if (typed.kind === "list") {
      return ok({
        accounts: [shown],
        nextCursor: null,
        identities: "read",
        searchTruncated: false,
      });
    }
    if (typed.kind === "account") return ok(detailOf(shown));
    if (typed.kind === "actions") return ok({ actions });
    return changeAnswer(typed);
  };
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("Connect admin changes", () => {
  it("sends nothing until the owner confirms, and Cancel sends nothing", async () => {
    await openAccount();
    await press("Unlink");
    expect(dialogText()).toContain("Unlink “Studio Mac” from Person A?");
    expect(dialogText()).toContain("Account id: user_a");
    expect(changes()).toEqual([]);
    await press("Cancel", dialog());
    expect(dialogText()).toBeNull();
    expect(changes()).toEqual([]);
  });

  it("offers Unlink only for a machine that is still linked", async () => {
    await openAccount();
    expect(pageText()).toContain("Old PC");
    expect(buttons("Unlink")).toHaveLength(1);
  });

  it("unlinks the named machine of the named account, then reads the account again", async () => {
    await openAccount();
    await press("Unlink");
    const before = {
      account: count("account"),
      actions: count("actions"),
      overview: count("overview"),
    };
    shown = account({ machineCount: 1 });
    actions = [recorded()];
    await press("Unlink machine", dialog());
    expect(changes()).toEqual([{ kind: "unlink", userId: "user_a", environmentId: "env-1" }]);
    expect(dialogText()).toBeNull();
    expect(count("account")).toBe(before.account + 1);
    expect(count("actions")).toBe(before.actions + 1);
    expect(count("overview")).toBe(before.overview + 1);
    // The account's row follows the new reading without a list reload.
    expect(pageText()).toContain("Machines: 1 · Phones: 1");
    expect(pageText()).toContain("Unlinked machine Studio Mac");
  });

  it("removes the named phone of the named account", async () => {
    await openAccount();
    await press("Remove");
    expect(dialogText()).toContain("Remove “Pocket” from Person A?");
    await press("Remove phone", dialog());
    expect(changes()).toEqual([{ kind: "remove-phone", userId: "user_a", deviceId: "phone-1" }]);
    expect(dialogText()).toBeNull();
  });

  it("sets a machine limit only from a whole number between 0 and 1000", async () => {
    await openAccount();
    await press("Change limit");
    expect(dialogText()).toContain("Machine limit for Person A");
    expect(dialogText()).toContain("Now: Machine limit: 2, free plan");
    await act(async () => {
      dialog()!.findByType(RadioGroup).props.onValueChange("limited");
    });
    const type = async (value: string) => {
      await act(async () => {
        dialog()!.findByProps({ inputMode: "numeric" }).props.onChange({ target: { value } });
      });
    };
    for (const wrong of ["", "abc", "2.5", "-1", "1001"]) {
      await type(wrong);
      expect(buttons("Save", dialog())[0]!.props.disabled, wrong).toBe(true);
      expect(dialogText()).toContain("Enter a whole number from 0 to 1,000.");
      await press("Save", dialog());
    }
    expect(changes()).toEqual([]);

    await type(" 5 ");
    shown = account({ limit: { maxMachines: 5, source: "override" } });
    await press("Save", dialog());
    expect(changes()).toEqual([
      { kind: "limit", userId: "user_a", limit: { kind: "limited", maxMachines: 5 } },
    ]);
    expect(dialogText()).toBeNull();
    expect(pageText()).toContain("Machine limit: 5, set by an owner");
  });

  it("lifts the limit and puts it back to the plan default", async () => {
    shown = account({ limit: { maxMachines: 5, source: "override" } });
    await openAccount();
    await press("Change limit");
    await act(async () => {
      dialog()!.findByType(RadioGroup).props.onValueChange("unlimited");
    });
    await press("Save", dialog());
    await press("Change limit");
    await act(async () => {
      dialog()!.findByType(RadioGroup).props.onValueChange("default");
    });
    await press("Save", dialog());
    expect(changes().map((call) => (call as { limit: unknown }).limit)).toEqual([
      { kind: "unlimited" },
      { kind: "default" },
    ]);
  });

  it("keeps the dialog open with the reason when a change stops part way, and can send it again", async () => {
    await openAccount();
    await press("Unlink");
    const reads = count("account");
    changeAnswer = () => fail("action_failed", 503);
    await press("Unlink machine", dialog());
    expect(dialogText()).toContain("The change stopped part way");
    expect(dialogText()).toContain("HTTP 503 · trace trace-503");
    // The account is read again even so: part of the change may have been made.
    expect(count("account")).toBe(reads + 1);
    changeAnswer = () => ok({ unlinked: true });
    await press("Unlink machine", dialog());
    expect(changes()).toHaveLength(2);
    expect(dialogText()).toBeNull();
  });

  it("never says nothing was changed when a change got no answer", async () => {
    await openAccount();
    await press("Remove");
    changeAnswer = () => fail("timeout");
    await press("Remove phone", dialog());
    expect(dialogText()).toContain("No clear answer from SpecWithCode Connect");
    expect(dialogText()).toContain("The change may or may not have been made.");
    expect(dialogText()).not.toContain("Nothing was changed");
  });

  it("does not say nothing was changed when Connect could not read its data", async () => {
    await openAccount();
    await press("Change limit");
    // The relay reads the account again after writing the limit; that read can fail.
    changeAnswer = () => fail("unavailable", 503);
    await press("Save", dialog());
    expect(dialogText()).toContain("The change may or may not have been made.");
    expect(dialogText()).not.toContain("Nothing was changed");
  });

  it("names the machine, the phone and the account on each row's button", async () => {
    await openAccount();
    expect(buttons("Unlink")[0]!.props["aria-label"]).toBe("Unlink Studio Mac");
    expect(buttons("Remove")[0]!.props["aria-label"]).toBe("Remove Pocket");
    expect(buttons("Change limit")[0]!.props["aria-label"]).toBe(
      "Change the machine limit for Person A",
    );
  });

  it("says nothing was changed when the change could not be recorded", async () => {
    await openAccount();
    await press("Remove");
    changeAnswer = () => fail("not_recorded", 503);
    await press("Remove phone", dialog());
    expect(dialogText()).toContain("SpecWithCode Connect could not record the change");
    expect(dialogText()).toContain("Nothing was changed.");
  });

  it("cannot be sent twice or closed while a change is on its way", async () => {
    await openAccount();
    await press("Unlink");
    let answer: (value: unknown) => void = () => undefined;
    changeAnswer = () => new Promise((resolve) => (answer = resolve));
    const original = state.answer;
    state.answer = (call) =>
      ["unlink"].includes((call as Call).kind) ? changeAnswer(call as Call) : original(call);
    await press("Unlink machine", dialog());
    expect(buttons("Unlinking…", dialog())[0]!.props.disabled).toBe(true);
    await press("Unlinking…", dialog());
    await press("Cancel", dialog());
    expect(dialogText()).not.toBeNull();
    expect(changes()).toHaveLength(1);
    await act(async () => {
      answer(ok({ unlinked: true }));
    });
    expect(dialogText()).toBeNull();
  });
});

describe("Connect admin recent changes", () => {
  it("lists what was changed, for which account, by whom and how it ended", async () => {
    actions = [
      recorded({ id: "r3", action: "remove_phone", targetLabel: "Pocket", outcome: "failed" }),
      recorded({
        id: "r2",
        action: "set_machine_limit",
        targetId: null,
        targetLabel: null,
        limitSet: { kind: "limited", maxMachines: 5 },
      }),
      recorded({ id: "r1", outcome: "started" }),
    ];
    await openAccount();
    const rows = renderer!.root
      .findAllByProps({ "data-testid": "connect-admin-change" })
      .map((row) => textOf(row));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Removed phone Pocket");
    expect(rows[0]).toContain("Failed");
    expect(rows[0]).toContain("Account user_a · By user_owner");
    expect(rows[1]).toContain("Set the machine limit to 5");
    expect(rows[1]).toContain("Done");
    expect(rows[2]).toContain("Unlinked machine Studio Mac");
    expect(rows[2]).toContain("Not finished");
  });

  it("says so when nothing was changed yet, and when the record could not be read", async () => {
    await openAccount();
    expect(pageText()).toContain("No owner has changed anything yet.");
    act(() => renderer?.unmount());

    const original = state.answer;
    state.answer = (call) =>
      (call as Call).kind === "actions" ? fail("unavailable", 503) : original(call);
    await openAccount();
    expect(pageText()).not.toContain("No owner has changed anything yet.");
    expect(pageText()).toContain("SpecWithCode Connect could not read its data");
    state.answer = original;
    actions = [recorded()];
    await press("Try again");
    expect(pageText()).toContain("Unlinked machine Studio Mac");
  });
});

describe("Connect admin change helpers", () => {
  it("starts the limit dialog from what the account has now", () => {
    expect(machineLimitDraftOf({ maxMachines: 2, source: "free" })).toEqual({
      choice: "default",
      count: "2",
    });
    expect(machineLimitDraftOf({ maxMachines: 10, source: "founder" }).choice).toBe("default");
    expect(machineLimitDraftOf({ maxMachines: 7, source: "override" })).toEqual({
      choice: "limited",
      count: "7",
    });
    expect(machineLimitDraftOf({ maxMachines: null, source: "override" }).choice).toBe("unlimited");
  });

  it("turns the draft into what is sent, or nothing while the number is wrong", () => {
    expect(machineLimitSettingOf({ choice: "default", count: "junk" })).toEqual({
      kind: "default",
    });
    expect(machineLimitSettingOf({ choice: "unlimited", count: "" })).toEqual({
      kind: "unlimited",
    });
    expect(machineLimitSettingOf({ choice: "limited", count: "0" })).toEqual({
      kind: "limited",
      maxMachines: 0,
    });
    expect(machineLimitSettingOf({ choice: "limited", count: "1000" })).toEqual({
      kind: "limited",
      maxMachines: 1000,
    });
    for (const count of ["", "1001", "12345", "1e3", "٣"]) {
      expect(machineLimitSettingOf({ choice: "limited", count }), count).toBeNull();
    }
  });

  it("names every recorded action and outcome", () => {
    const text = (overrides: Partial<RelayAdminAction>) =>
      actionText(englishPhrase, recorded(overrides));
    expect(text({ targetLabel: null })).toBe("Unlinked machine env-1");
    expect(text({ action: "set_machine_limit", limitSet: { kind: "unlimited" } })).toBe(
      "Removed the machine limit",
    );
    expect(text({ action: "set_machine_limit", limitSet: { kind: "default" } })).toBe(
      "Reset the machine limit to the plan default",
    );
    expect(text({ action: "set_machine_limit", limitSet: null })).toBe("Changed the machine limit");
    expect(actionOutcome(recorded({ outcome: "started" })).tone).toBe("warning");
  });

  it("uses the read copy for failures that changed nothing", () => {
    expect(changeFailureCopy({ kind: "not_recorded", status: 503, traceId: null }).title).toBe(
      "SpecWithCode Connect could not record the change",
    );
    expect(
      changeFailureCopy({ kind: "unavailable", status: 503, traceId: null }).description,
    ).toContain("may or may not");
    expect(changeFailureCopy({ kind: "target_not_found", status: 404, traceId: null }).title).toBe(
      "That machine or phone is no longer on this account",
    );
    expect(
      changeFailureCopy({ kind: "network", status: null, traceId: null }).description,
    ).toContain("may or may not");
  });

  it("replaces one account's row and leaves the others", () => {
    const list = {
      accounts: [account(), account({ userId: "user_b" })],
      nextCursor: "next",
      identitiesRead: true,
      searchTruncated: false,
    };
    const next = withAccount(list, account({ machineCount: 9 }));
    expect(next.accounts.map((shownAccount) => shownAccount.machineCount)).toEqual([9, 2]);
    expect(next.nextCursor).toBe("next");
  });
});
