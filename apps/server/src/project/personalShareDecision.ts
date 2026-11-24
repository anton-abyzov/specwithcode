/**
 * The decisions two machines make about one Percy (1448 D-13 to D-15), pure
 * so both sides of a pair reach them from the same facts and every branch is
 * tested. `LinkedPeerSync`, the `personal-share` peer path and the reconciler
 * call these; nothing here reads or writes anything.
 *
 * - `shareAccess`: whether this machine accepts a peer at all (section 1 of
 *   the rework), from this machine's own stored facts. The peer's claims (its
 *   protocol version and link id) are its own word and only ever refuse.
 * - `phase1Answer`: what this machine tells a peer in the first phase. A
 *   refusal carries only the reason, never anything about the assistant.
 * - `decideShareStep`: once both accept each other, who starts the link, who
 *   joins and who admits.
 *
 * @module personalShareDecision
 */
import { PERSONAL_LINK_PROTOCOL_VERSION } from "@specweave-studio/contracts";
import type { StudioFleetWorkers } from "@specweave-studio/contracts/studioFleet";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** Why a machine does not share Percy with a peer; the only thing a refused peer learns. */
export type PersonalShareRefusalReason =
  | "switch_off"
  | "not_confirmed"
  | "legacy_grant"
  | "no_grant"
  | "other_account"
  | "older_version";

/** A work grant between the two machines, as one of them stores it. */
export type ShareGrantKind = "own" | "legacy" | "team" | "none";

/**
 * The one grant rule for Percy: an `own` grant (the owner's, from a machine
 * that manages this one) that is not legacy and not revoked. A legacy grant
 * can compute as `own`, so the legacy check is part of it.
 */
export const shareGrantKind = (
  grant:
    | {
        readonly kind?: "own" | "team" | undefined;
        readonly legacy?: boolean | undefined;
        readonly revoked: boolean;
      }
    | null
    | undefined,
): ShareGrantKind => {
  if (grant === null || grant === undefined || grant.revoked) return "none";
  if (grant.legacy === true) return "legacy";
  return grant.kind === "own" ? "own" : "team";
};

/** What this machine knows about itself, from its own settings, link and Connect sign-in. */
export interface ShareSelfFacts {
  readonly environmentId: string;
  /** The owner's switch on this machine. */
  readonly switchOn: boolean;
  /** Linked to Connect, the assistant setting on, and an assistant here. */
  readonly ready: boolean;
  /** The account's link id; null while this machine is not linked to Connect. */
  readonly linkId: string | null;
  /** The machines the owner confirmed on this machine. */
  readonly confirmed: ReadonlySet<string>;
  /**
   * Machines a seat this one is linked with lists as members of the link: this
   * seat's own members, and what its linked members told it. Never a list the
   * candidate itself sent.
   */
  readonly vouched: ReadonlySet<string>;
}

/** The grant between this machine and the peer, from this machine's side. */
export interface ShareGrantFacts {
  /** The grant this machine issued to the peer (the peer calls with it). */
  readonly issued: ShareGrantKind;
  /**
   * This machine calls the peer with a grant it holds there, and the peer
   * checks that grant on every call. Counts only on the calling side, and
   * only as `heldGrantCounts` reads it.
   */
  readonly heldUsable: boolean;
}

/**
 * Whether a worker grant this machine holds on the peer counts toward
 * sharing Percy with it (D-13), read from `FleetWorkerGrants.status`.
 *
 * The kind of a held grant is the peer's to decide (`grantKindOf`: `own`
 * only while the holder manages the peer and the peer's owner did not mark
 * it another person's), and this machine stores no kind for it. A held grant
 * can be a team grant: one minted with a pairing code the peer's owner
 * pasted (`mintWorkerGrant` with `pairingCode`), with no management pairing
 * there, is `team` on the peer. So the holder counts only a grant minted
 * through its management pairing on the peer and still renewable through it
 * (`renewable`, which needs that pairing now and `ongoingConsent` from the
 * mint): the half of `own` it can see. The other half, the peer's owner
 * marking the holder another person's, only the peer sees; it refuses then.
 */
export const heldGrantCounts = (
  workers: Pick<StudioFleetWorkers, "status" | "renewable">,
): boolean => workers.renewable && (workers.status === "allowed" || workers.status === "expired");

/**
 * What the peer said about itself; its own word, so it can only refuse.
 * `environmentId` is never the peer's claim: it is the id its grant names
 * (on the answering side) or the pinned fleet target (on the calling side).
 */
export interface SharePeerClaims {
  readonly environmentId: string;
  /** Null when the peer named none: refused as an older version. */
  readonly protocolVersion: number | null;
  /** Null when the peer named none: refused as another account. */
  readonly linkId: string | null;
}

export type ShareAccess =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PersonalShareRefusalReason };

/** A machine the owner removed from this seat's link, or that left it, as the seat remembers it. */
export interface ShareRemoval {
  readonly environmentId: string;
  readonly removedAt?: string | undefined;
}

const epochMillis = (iso: string | undefined) =>
  iso === undefined
    ? undefined
    : Option.getOrUndefined(Option.map(DateTime.make(iso), DateTime.toEpochMillis));

/**
 * Whether a removal this seat remembers still keeps `peer` out: until the
 * owner turns the peer's switch on after it (the peer's `switchedOnAt`, its
 * own stored fact). A removal without a time, or a peer that names no time,
 * keeps it out. Cleared for good when the peer is linked again
 * (`bindingRelinking`).
 */
export const removalStands = (
  removals: ReadonlyArray<ShareRemoval>,
  peer: string,
  switchedOnAt: string | undefined,
): boolean => {
  const on = epochMillis(switchedOnAt);
  return removals.some((entry) => {
    if (entry.environmentId !== peer) return false;
    const removed = epochMillis(entry.removedAt);
    return removed === undefined || on === undefined || on <= removed;
  });
};

/** `self` with `peer` neither confirmed nor vouched for, while a removal keeps it out. */
export const withoutRemoved = (
  self: ShareSelfFacts,
  removals: ReadonlyArray<ShareRemoval>,
  peer: string,
  switchedOnAt: string | undefined,
): ShareSelfFacts => {
  if (!removalStands(removals, peer, switchedOnAt)) return self;
  const confirmed = new Set(self.confirmed);
  const vouched = new Set(self.vouched);
  confirmed.delete(peer);
  vouched.delete(peer);
  return { ...self, confirmed, vouched };
};

/** Whether the grants this machine stores let it share with the peer. */
export const shareGrantStanding = (grant: ShareGrantFacts): "ok" | "legacy_grant" | "no_grant" => {
  if (grant.issued === "own" || grant.heldUsable) return "ok";
  return grant.issued === "legacy" ? "legacy_grant" : "no_grant";
};

/**
 * This machine's own half of section 1, before the peer has said anything:
 * its switch on and ready, the peer confirmed here or vouched for by a seat
 * this one is linked with, and a usable own grant in at least one direction.
 * What a calling machine tells the peer in its first request.
 */
export const sharePreconditions = (
  self: ShareSelfFacts,
  peerEnvironmentId: string,
  grant: ShareGrantFacts,
): ShareAccess => {
  if (!self.switchOn || !self.ready || self.linkId === null)
    return { ok: false, reason: "switch_off" };
  if (peerEnvironmentId === self.environmentId) return { ok: false, reason: "not_confirmed" };
  if (!self.confirmed.has(peerEnvironmentId) && !self.vouched.has(peerEnvironmentId))
    return { ok: false, reason: "not_confirmed" };
  const standing = shareGrantStanding(grant);
  return standing === "ok" ? { ok: true } : { ok: false, reason: standing };
};

/**
 * Section 1 of the rework, checked by each machine for the other before any
 * content moves: the preconditions above, and the peer's protocol version and
 * link id. A claim the peer did not make refuses.
 */
export const shareAccess = (
  self: ShareSelfFacts,
  peer: SharePeerClaims,
  grant: ShareGrantFacts,
): ShareAccess => {
  if (peer.protocolVersion === null || peer.protocolVersion < PERSONAL_LINK_PROTOCOL_VERSION)
    return { ok: false, reason: "older_version" };
  if (!self.switchOn || !self.ready || self.linkId === null)
    return { ok: false, reason: "switch_off" };
  if (peer.linkId === null || peer.linkId !== self.linkId)
    return { ok: false, reason: "other_account" };
  return sharePreconditions(self, peer.environmentId, grant);
};

/** This seat's part in the link, as it tells an accepted peer. */
export interface ShareSeatState {
  readonly linkId: string;
  readonly start: boolean;
  /** The link's name from this machine's switch, when the owner gave one. */
  readonly name: string | undefined;
  /** Whether this seat is linked to `linkId` with at least one other machine. */
  readonly linked: boolean;
  /** The link's members by environment id when linked (this seat included); else none. */
  readonly members: ReadonlyArray<string>;
  /** Shared memory files: never local-only or secret-flagged ones. */
  readonly memoryFileCount: number;
  /** When the owner last turned this machine's switch on; absent when it never said. */
  readonly switchedOnAt?: string | undefined;
}

export type Phase1Answer =
  | {
      readonly accepted: false;
      readonly protocolVersion: number;
      readonly environmentId: string;
      readonly reason: PersonalShareRefusalReason;
      readonly linked?: false;
    }
  | ({
      readonly accepted: true;
      readonly protocolVersion: number;
      readonly environmentId: string;
      readonly switchOn: true;
    } & ShareSeatState);

/**
 * What this machine answers a peer in phase 1: its reason when it refuses the
 * peer, and nothing else; its state only when it accepts.
 */
export const phase1Answer = (
  environmentId: string,
  access: ShareAccess,
  seat: () => ShareSeatState,
  linked?: boolean,
): Phase1Answer =>
  access.ok
    ? {
        accepted: true,
        protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
        environmentId,
        switchOn: true,
        ...seat(),
      }
    : {
        accepted: false,
        protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
        environmentId,
        reason: access.reason,
        // Said only by a seat that left: a refusal otherwise carries its reason alone.
        ...(access.reason === "switch_off" && linked === false ? { linked: false as const } : {}),
      };

/** A seat as `decideShareStep` reads it: the state an accepted peer reported, or this seat's own. */
export interface ShareSeatView {
  readonly environmentId: string;
  readonly start: boolean;
  readonly linked: boolean;
  readonly members: ReadonlyArray<string>;
}

export type ShareWaitDetail =
  /** Neither seat is linked and neither starts the link. */
  | "no_starter"
  /** The peer joins this seat's link (or this seat, the starter, waits for it). */
  | "peer_joins"
  /** This seat lists the peer; the peer has not listed it back yet. */
  | "peer_admits"
  /** Two links with this id met, and neither lists the other. */
  | "two_links";

export type ShareStep =
  /** Both list each other: keep in step. */
  | { readonly kind: "in_step" }
  /** This seat joins the peer's link, merging into it first. */
  | { readonly kind: "join"; readonly startIgnored: boolean }
  /** This seat, the starter, writes the link the peer joined; it merges nothing. */
  | { readonly kind: "start" }
  /** This linked seat lists the peer, which joined its link. */
  | { readonly kind: "admit" }
  | { readonly kind: "wait"; readonly detail: ShareWaitDetail; readonly startIgnored: boolean };

const lists = (seat: ShareSeatView, other: string) => seat.linked && seat.members.includes(other);

/** The seat the link starts from, of two lone seats: the one with `start`, the lower id of two. */
const starterOf = (left: ShareSeatView, right: ShareSeatView): ShareSeatView | null => {
  if (left.start && right.start) return left.environmentId < right.environmentId ? left : right;
  if (left.start) return left;
  if (right.start) return right;
  return null;
};

/**
 * What this seat does about the peer once both accept each other (D-15). A
 * seat linked with others outranks a lone starter; existing members never
 * rename anything and only admit. Two links with the same id wait for the
 * owner rather than merge two links into one.
 */
export const decideShareStep = (self: ShareSeatView, peer: ShareSeatView): ShareStep => {
  const selfLists = lists(self, peer.environmentId);
  const peerLists = lists(peer, self.environmentId);
  const starter = self.linked || peer.linked ? null : starterOf(self, peer);
  const startIgnored =
    self.start && peer.start && starter !== null && starter.environmentId !== self.environmentId;
  if (self.linked && peer.linked) {
    if (selfLists && peerLists) return { kind: "in_step" };
    if (peerLists) return { kind: "admit" };
    if (selfLists) return { kind: "wait", detail: "peer_admits", startIgnored: false };
    return { kind: "wait", detail: "two_links", startIgnored: false };
  }
  if (self.linked) return { kind: "wait", detail: "peer_joins", startIgnored: false };
  if (peer.linked) {
    // The peer joined this lone starter: its link lists just the two of them.
    const firstLinkOfStarter =
      peerLists &&
      peer.members.length === 2 &&
      self.start &&
      (!peer.start || self.environmentId < peer.environmentId);
    return firstLinkOfStarter ? { kind: "start" } : { kind: "join", startIgnored: false };
  }
  if (starter === null) return { kind: "wait", detail: "no_starter", startIgnored: false };
  if (starter.environmentId === self.environmentId)
    return { kind: "wait", detail: "peer_joins", startIgnored: false };
  return { kind: "join", startIgnored };
};

/** The default name of the one Percy when the seats' names differ and the owner gave none. */
export const DEFAULT_SHARED_PERCY_NAME = "Percy";

/**
 * The link's name, from the starter (D-15): the name on its switch, else its
 * assistant's name when the other seat's is the same, else "Percy".
 */
export const sharedLinkName = (
  starter: { readonly name: string | undefined; readonly assistantName: string },
  other: { readonly assistantName: string } | undefined,
): string => {
  const given = starter.name?.trim();
  if (given !== undefined && given !== "") return given;
  if (other === undefined || other.assistantName === starter.assistantName)
    return starter.assistantName;
  return DEFAULT_SHARED_PERCY_NAME;
};

/** The sentence `status` shows for a pair that waits; plain words, no machine names. */
export const waitDetailText = (detail: ShareWaitDetail, startIgnored: boolean): string => {
  const base = {
    no_starter:
      "Neither machine starts the link. Choose the machine Percy starts from: run `specwithcode percy on --start` there.",
    peer_joins: "Waiting for the other machine to join this machine's Percy.",
    peer_admits: "Waiting for the other machine to list this one; it does so on its next sync.",
    two_links:
      "Two separate links of your Percy exist. Turn Percy off and on again on the machine with fewer members to join them.",
  }[detail];
  return startIgnored
    ? `${base} Both machines were set to start the link; this machine's setting was ignored.`
    : base;
};
