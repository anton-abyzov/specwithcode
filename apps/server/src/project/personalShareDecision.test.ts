import { PERSONAL_LINK_PROTOCOL_VERSION } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decideShareStep,
  phase1Answer,
  shareAccess,
  shareGrantKind,
  shareGrantStanding,
  type ShareGrantFacts,
  type ShareSeatView,
  type ShareSelfFacts,
  sharedLinkName,
  waitDetailText,
} from "./personalShareDecision.ts";

const LINK = "logical:percy:0123456789abcdef0123456789abcdef";

const self = (overrides: Partial<ShareSelfFacts> = {}): ShareSelfFacts => ({
  environmentId: "env-studio",
  switchOn: true,
  ready: true,
  linkId: LINK,
  confirmed: new Set(["env-laptop"]),
  vouched: new Set(),
  ...overrides,
});
const own: ShareGrantFacts = { issued: "own", heldUsable: false };
const peer = {
  environmentId: "env-laptop",
  protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
  linkId: LINK,
};

describe("shareGrantKind", () => {
  it("is own only for an own grant that is neither legacy nor revoked", () => {
    expect(shareGrantKind({ kind: "own", revoked: false })).toBe("own");
    expect(shareGrantKind({ kind: "own", legacy: false, revoked: false })).toBe("own");
    expect(shareGrantKind({ kind: "own", legacy: true, revoked: false })).toBe("legacy");
    expect(shareGrantKind({ kind: "team", revoked: false })).toBe("team");
    expect(shareGrantKind({ revoked: false })).toBe("team");
    expect(shareGrantKind({ kind: "own", revoked: true })).toBe("none");
    expect(shareGrantKind({ kind: "own", legacy: true, revoked: true })).toBe("none");
    expect(shareGrantKind(undefined)).toBe("none");
    expect(shareGrantKind(null)).toBe("none");
  });
});

describe("shareGrantStanding", () => {
  it("accepts an issued own grant or a held grant the peer checks", () => {
    expect(shareGrantStanding({ issued: "own", heldUsable: false })).toBe("ok");
    expect(shareGrantStanding({ issued: "none", heldUsable: true })).toBe("ok");
    expect(shareGrantStanding({ issued: "team", heldUsable: true })).toBe("ok");
  });
  it("names a legacy grant, and treats team or none as no grant", () => {
    expect(shareGrantStanding({ issued: "legacy", heldUsable: false })).toBe("legacy_grant");
    expect(shareGrantStanding({ issued: "team", heldUsable: false })).toBe("no_grant");
    expect(shareGrantStanding({ issued: "none", heldUsable: false })).toBe("no_grant");
  });
});

describe("shareAccess", () => {
  it("accepts a confirmed peer of the same account with an own grant", () => {
    expect(shareAccess(self(), peer, own)).toEqual({ ok: true });
  });
  it("accepts a peer a linked seat vouches for", () => {
    const facts = self({ confirmed: new Set(), vouched: new Set(["env-laptop"]) });
    expect(shareAccess(facts, peer, own)).toEqual({ ok: true });
  });
  it("refuses a peer that runs an older protocol before anything else", () => {
    expect(shareAccess(self({ switchOn: false }), { ...peer, protocolVersion: 1 }, own)).toEqual({
      ok: false,
      reason: "older_version",
    });
  });
  it("refuses while this machine's switch is off, it is not ready or has no Connect link", () => {
    for (const facts of [self({ switchOn: false }), self({ ready: false }), self({ linkId: null })])
      expect(shareAccess(facts, peer, own)).toEqual({ ok: false, reason: "switch_off" });
  });
  it("refuses another account's machine", () => {
    expect(shareAccess(self(), { ...peer, linkId: "logical:percy:other" }, own)).toEqual({
      ok: false,
      reason: "other_account",
    });
    expect(shareAccess(self(), { ...peer, linkId: null }, own)).toEqual({
      ok: false,
      reason: "other_account",
    });
  });
  it("leaves claims the peer has not made yet for later", () => {
    expect(shareAccess(self(), { environmentId: "env-laptop" }, own)).toEqual({ ok: true });
  });
  it("refuses a peer neither confirmed here nor vouched for, and this machine itself", () => {
    expect(shareAccess(self({ confirmed: new Set() }), peer, own)).toEqual({
      ok: false,
      reason: "not_confirmed",
    });
    expect(
      shareAccess(
        self({ confirmed: new Set(["env-studio"]) }),
        { environmentId: "env-studio" },
        own,
      ),
    ).toEqual({ ok: false, reason: "not_confirmed" });
  });
  it("refuses without a usable own grant either way", () => {
    expect(shareAccess(self(), peer, { issued: "legacy", heldUsable: false })).toEqual({
      ok: false,
      reason: "legacy_grant",
    });
    expect(shareAccess(self(), peer, { issued: "team", heldUsable: false })).toEqual({
      ok: false,
      reason: "no_grant",
    });
    expect(shareAccess(self(), peer, { issued: "none", heldUsable: false })).toEqual({
      ok: false,
      reason: "no_grant",
    });
    expect(shareAccess(self(), peer, { issued: "none", heldUsable: true })).toEqual({ ok: true });
  });
});

describe("phase1Answer", () => {
  const seat = {
    linkId: LINK,
    start: true,
    name: "Percy",
    linked: true,
    members: ["env-studio", "env-desktop"],
    memoryFileCount: 4,
  };
  it("carries only the reason when it refuses", () => {
    for (const reason of [
      "switch_off",
      "not_confirmed",
      "legacy_grant",
      "no_grant",
      "other_account",
      "older_version",
    ] as const) {
      const answer = phase1Answer("env-studio", { ok: false, reason }, () => {
        throw new Error("the seat is never read for a refusal");
      });
      expect(Object.keys(answer).toSorted()).toEqual(
        ["accepted", "environmentId", "protocolVersion", "reason"].toSorted(),
      );
      expect(answer).toEqual({
        accepted: false,
        protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
        environmentId: "env-studio",
        reason,
      });
    }
  });
  it("carries the seat's state when it accepts", () => {
    expect(phase1Answer("env-studio", { ok: true }, () => seat)).toEqual({
      accepted: true,
      protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
      environmentId: "env-studio",
      switchOn: true,
      ...seat,
    });
  });
});

const view = (
  environmentId: string,
  overrides: Partial<Omit<ShareSeatView, "environmentId">> = {},
): ShareSeatView => ({ environmentId, start: false, linked: false, members: [], ...overrides });

describe("decideShareStep", () => {
  const linked = (environmentId: string, members: ReadonlyArray<string>, start = false) =>
    view(environmentId, { linked: true, members, start });

  it("keeps two seats that list each other in step", () => {
    const members = ["a", "b"];
    expect(decideShareStep(linked("a", members), linked("b", members))).toEqual({
      kind: "in_step",
    });
  });
  it("admits a peer that joined this seat's link, and waits for the peer to admit this one", () => {
    expect(decideShareStep(linked("a", ["a", "b"]), linked("c", ["a", "b", "c"]))).toEqual({
      kind: "admit",
    });
    expect(decideShareStep(linked("c", ["a", "b", "c"]), linked("a", ["a", "b"]))).toEqual({
      kind: "wait",
      detail: "peer_admits",
      startIgnored: false,
    });
  });
  it("leaves two links with the same id waiting on both sides", () => {
    const left = linked("a", ["a", "b"]);
    const right = linked("c", ["c", "d", "e"]);
    for (const [one, two] of [
      [left, right],
      [right, left],
    ] as const)
      expect(decideShareStep(one, two)).toEqual({
        kind: "wait",
        detail: "two_links",
        startIgnored: false,
      });
  });
  it("lets a lone seat join a linked one, even a lone starter", () => {
    const pair = linked("a", ["a", "b"]);
    expect(decideShareStep(pair, view("c", { start: true }))).toEqual({
      kind: "wait",
      detail: "peer_joins",
      startIgnored: false,
    });
    expect(decideShareStep(view("c", { start: true }), pair)).toEqual({
      kind: "join",
      startIgnored: false,
    });
    expect(decideShareStep(view("c"), pair)).toEqual({ kind: "join", startIgnored: false });
  });
  it("starts the link on the starter once the peer joined it", () => {
    const joined = linked("b", ["a", "b"]);
    expect(decideShareStep(view("a", { start: true }), joined)).toEqual({ kind: "start" });
    // Not the starter, or the link already holds a third machine: join it instead.
    expect(decideShareStep(view("a"), joined)).toEqual({ kind: "join", startIgnored: false });
    expect(decideShareStep(view("a", { start: true }), linked("b", ["a", "b", "c"]))).toEqual({
      kind: "join",
      startIgnored: false,
    });
    // Both were set to start: only the lower id starts.
    expect(decideShareStep(view("b", { start: true }), linked("a", ["a", "b"], true))).toEqual({
      kind: "join",
      startIgnored: false,
    });
    expect(decideShareStep(view("a", { start: true }), linked("b", ["a", "b"], true))).toEqual({
      kind: "start",
    });
  });
  it("waits for a starter when neither lone seat starts", () => {
    for (const [one, two] of [
      [view("a"), view("b")],
      [view("b"), view("a")],
    ] as const)
      expect(decideShareStep(one, two)).toEqual({
        kind: "wait",
        detail: "no_starter",
        startIgnored: false,
      });
  });
  it("joins the starter of two lone seats, and the lower id starts when both are set", () => {
    expect(decideShareStep(view("b"), view("a", { start: true }))).toEqual({
      kind: "join",
      startIgnored: false,
    });
    expect(decideShareStep(view("a", { start: true }), view("b"))).toEqual({
      kind: "wait",
      detail: "peer_joins",
      startIgnored: false,
    });
    expect(decideShareStep(view("b", { start: true }), view("a", { start: true }))).toEqual({
      kind: "join",
      startIgnored: true,
    });
    expect(decideShareStep(view("a", { start: true }), view("b", { start: true }))).toEqual({
      kind: "wait",
      detail: "peer_joins",
      startIgnored: false,
    });
  });
  it("never has both seats join or both start", () => {
    const seats = [
      view("a"),
      view("a", { start: true }),
      linked("a", ["a", "b"]),
      linked("a", ["a", "c"]),
    ];
    const peers = [
      view("b"),
      view("b", { start: true }),
      linked("b", ["a", "b"]),
      linked("b", ["b", "c"]),
    ];
    for (const one of seats)
      for (const two of peers) {
        const left = decideShareStep(one, two).kind;
        const right = decideShareStep(two, one).kind;
        expect([left, right]).not.toEqual(["join", "join"]);
        expect([left, right]).not.toEqual(["start", "start"]);
        expect([left, right]).not.toEqual(["admit", "admit"]);
      }
  });
});

describe("sharedLinkName", () => {
  it("takes the switch's name, else the starter's when both agree, else Percy", () => {
    expect(
      sharedLinkName({ name: "Jarvis", assistantName: "Percy" }, { assistantName: "Ada" }),
    ).toBe("Jarvis");
    expect(
      sharedLinkName({ name: undefined, assistantName: "Ada" }, { assistantName: "Ada" }),
    ).toBe("Ada");
    expect(sharedLinkName({ name: " ", assistantName: "Ada" }, { assistantName: "Bea" })).toBe(
      "Percy",
    );
    expect(sharedLinkName({ name: undefined, assistantName: "Ada" }, undefined)).toBe("Ada");
  });
});

describe("waitDetailText", () => {
  it("names the starter command, and notes an ignored start flag", () => {
    expect(waitDetailText("no_starter", false)).toContain("specwithcode percy on --start");
    expect(waitDetailText("peer_joins", true)).toContain("ignored");
    for (const detail of ["no_starter", "peer_joins", "peer_admits", "two_links"] as const)
      expect(waitDetailText(detail, false)).not.toMatch(/—|Studio/);
  });
});
