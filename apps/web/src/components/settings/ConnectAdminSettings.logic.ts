import type {
  RelayAdminAccount,
  RelayAdminAccountsResponse,
  RelayAdminMachine,
  RelayAdminMachineLimit,
  RelayAdminOverviewResponse,
} from "@specweave-studio/contracts/relayAdmin";

import type { ConnectAdminFailure } from "~/cloud/connectAdminState";
import type { TranslatePhrase } from "~/i18n";

/** One read on the page: never "ready" with made-up data after a failure. */
export type Loadable<A> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly failure: ConnectAdminFailure }
  | { readonly status: "ready"; readonly value: A };

export const LOADING = { status: "loading" } as const;

/** The accounts on screen: pages of the newest-first list, or one search answer. */
export interface ConnectAdminAccountList {
  readonly accounts: ReadonlyArray<RelayAdminAccount>;
  readonly nextCursor: string | null;
  /** False when Clerk could not be read for any page shown: ids only there. */
  readonly identitiesRead: boolean;
  readonly searchTruncated: boolean;
}

export function accountListOf(page: RelayAdminAccountsResponse): ConnectAdminAccountList {
  return {
    accounts: page.accounts,
    nextCursor: page.nextCursor,
    identitiesRead: page.identities === "read",
    searchTruncated: page.searchTruncated,
  };
}

/** Adds the next page; an account that moved between pages shows once, newest reading. */
export function appendAccountPage(
  list: ConnectAdminAccountList,
  page: RelayAdminAccountsResponse,
): ConnectAdminAccountList {
  const incoming = new Set(page.accounts.map((account) => account.userId));
  return {
    accounts: [
      ...list.accounts.filter((account) => !incoming.has(account.userId)),
      ...page.accounts,
    ],
    nextCursor: page.nextCursor,
    identitiesRead: list.identitiesRead && page.identities === "read",
    searchTruncated: false,
  };
}

export function accountTitle(account: RelayAdminAccount): string {
  return account.name ?? account.email ?? account.userId;
}

/** The lines under the name: the email when the name is shown, and always the id. */
export function accountSubtitle(account: RelayAdminAccount): string {
  const email = account.name !== null && account.email !== null ? account.email : null;
  const id = account.name === null && account.email === null ? null : account.userId;
  return [email, id].filter((part) => part !== null).join(" · ");
}

export function machineLimitText(tx: TranslatePhrase, limit: RelayAdminMachineLimit): string {
  if (limit.maxMachines === null) {
    return limit.source === "override"
      ? tx("No machine limit, set by an owner")
      : tx("No machine limit");
  }
  const count = limit.maxMachines;
  if (limit.source === "override") return tx("Machine limit: {count}, set by an owner", { count });
  if (limit.source === "founder") return tx("Machine limit: {count}, founder", { count });
  return tx("Machine limit: {count}, free plan", { count });
}

export type MachineStateTone = "success" | "warning" | "error" | "outline";

/**
 * A machine's state in plain words, from what the relay recorded for its tunnel
 * and what Cloudflare reports now. The phrase is the English catalog key.
 */
export function machineState(machine: RelayAdminMachine): {
  readonly phrase: string;
  readonly tone: MachineStateTone;
} {
  if (machine.unlinkedAt !== null) return { phrase: "Unlinked", tone: "outline" };
  switch (machine.tunnel) {
    case "none":
      return { phrase: "Linked without a Connect tunnel", tone: "outline" };
    case "provisioning":
      return { phrase: "Tunnel is being set up", tone: "warning" };
    case "released":
      return { phrase: "Offline: the machine gave its tunnel back", tone: "outline" };
    case "ready":
      break;
  }
  switch (machine.live) {
    case "healthy":
      return { phrase: "Online", tone: "success" };
    case "degraded":
      return { phrase: "Online, connection degraded", tone: "warning" };
    case "down":
      return { phrase: "Offline: the tunnel is down", tone: "error" };
    case "inactive":
      return { phrase: "Offline: the tunnel never connected", tone: "outline" };
    case "unknown":
      return { phrase: "Tunnel ready, live status not read", tone: "outline" };
  }
}

/** Title and next step for a failed read. Both are English catalog keys. */
export function failureCopy(failure: ConnectAdminFailure): {
  readonly title: string;
  readonly description: string;
} {
  switch (failure.kind) {
    case "signed_out":
      return {
        title: "Sign in to SpecWithCode Connect",
        description: "This page needs a Connect session in this window.",
      };
    case "session_unread":
      return {
        title: "Could not read this window's Connect session",
        description: "Nothing was changed. Try again in a moment.",
      };
    case "not_owner":
      return {
        title: "This account is not a Connect owner",
        description: "SpecWithCode Connect does not list this account as an owner.",
      };
    case "account_not_found":
      return {
        title: "No Connect account has that id",
        description: "It may have been deleted since the list was read.",
      };
    case "unavailable":
      return {
        title: "SpecWithCode Connect could not read its data",
        description: "Nothing was changed. Try again in a moment.",
      };
    case "timeout":
      return {
        title: "SpecWithCode Connect did not answer in time",
        description: "Nothing was changed. Try again in a moment.",
      };
    case "network":
      return {
        title: "Could not reach SpecWithCode Connect",
        description: "Check this computer's connection, then try again.",
      };
    case "failed":
      return {
        title: "SpecWithCode Connect sent an answer this page could not read",
        description: "Nothing was changed. Try again in a moment.",
      };
  }
}

/** What a retry cannot fix: asking again would only repeat the answer. */
export function failureIsFinal(failure: ConnectAdminFailure): boolean {
  return failure.kind === "not_owner" || failure.kind === "signed_out";
}

export function overviewTiles(
  tx: TranslatePhrase,
  overview: RelayAdminOverviewResponse,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  return [
    { label: tx("Accounts"), value: String(overview.accounts) },
    { label: tx("Linked machines"), value: String(overview.linkedMachines) },
    {
      label: tx("Tunnels ready / allocated"),
      value: `${overview.tunnelsReady} / ${overview.tunnelsAllocated}`,
    },
    { label: tx("Phones"), value: String(overview.phones) },
    {
      label: tx("Founder seats taken"),
      value: `${overview.founderSeatsGranted} / ${overview.founderSeatCap}`,
    },
    { label: tx("Machine limit on the free plan"), value: String(overview.freeMachineLimit) },
    {
      label: tx("Tunnel cap for all accounts"),
      value: overview.globalTunnelCap === null ? tx("No cap") : String(overview.globalTunnelCap),
    },
  ];
}

/** A date and time in the reader's language; the raw text when it is not a date. */
export function formatAdminTime(
  iso: string,
  locale: string | undefined,
  timeZone?: string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}
