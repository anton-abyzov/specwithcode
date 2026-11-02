import { parseTeamRulesText, type TeamRulesState } from "@specweave-studio/shared/teamRules";
import { TEAM_RULES_FINGERPRINT_HEADER } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  callerFingerprint,
  isPhoneSession,
  sessionFollowsReachRules,
  teamRulesOpenSessionRefusal,
  teamRulesSessionRefusal,
} from "./TeamRulesReach.ts";

const active = (body: Record<string, unknown>): TeamRulesState => {
  const parsed = parseTeamRulesText(JSON.stringify({ version: 1, owner: "Acme", ...body }));
  if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
  return { status: "active", rules: parsed.rules, fingerprint: "3a9f", warnings: [] };
};
const hold: TeamRulesState = { status: "hold", issues: ["broken"], owner: "Acme" };
const person = { subject: "desktop-bootstrap", coordinator: false };
const phone = { subject: "phone-link:abc", coordinator: false };
const peer = { subject: "fleet-invitation", coordinator: true };

describe("sessions under reach rules", () => {
  it("knows a phone by its link or its own word", () => {
    expect(isPhoneSession(phone)).toBe(true);
    expect(isPhoneSession({ subject: "x", deviceType: "tablet" })).toBe(true);
    expect(isPhoneSession({ subject: "x", deviceType: "desktop" })).toBe(false);
    expect(sessionFollowsReachRules(person)).toBe(false);
    expect(sessionFollowsReachRules(phone)).toBe(true);
    expect(sessionFollowsReachRules(peer)).toBe(true);
  });

  it("refuses a phone, leaving a person's desktop alone", () => {
    const state = active({ reach: { phones: false } });
    expect(teamRulesSessionRefusal(state, phone)?.reason).toBe("reach");
    expect(teamRulesSessionRefusal(state, person)).toBeNull();
  });

  it("refuses a session that came through Connect", () => {
    const state = active({ reach: { connect: false } });
    expect(
      teamRulesSessionRefusal(state, { subject: "cloud-connect", coordinator: false })?.reason,
    ).toBe("reach");
  });

  it("refuses a coordinator under none", () => {
    expect(teamRulesSessionRefusal(active({ reach: { machines: "none" } }), peer)?.reason).toBe(
      "machines",
    );
  });

  it("asks a calling machine for its fingerprint under same-rules", () => {
    const state = active({ reach: { machines: "same-rules" } });
    const fingerprint = state.status === "active" ? state.fingerprint : "";
    expect(teamRulesSessionRefusal(state, peer, fingerprint)).toBeNull();
    expect(teamRulesSessionRefusal(state, peer, "other")?.reason).toBe("machines");
    expect(teamRulesSessionRefusal(state, peer)?.reason).toBe("machines");
    // A person's client opened through a coordinator names no rules.
    expect(
      teamRulesSessionRefusal(state, { subject: "desktop-bootstrap", coordinator: true }),
    ).toBeNull();
  });

  it("leaves same-rules to each request, so a matching machine's wait is not ended", () => {
    const same = active({ reach: { machines: "same-rules" } });
    expect(teamRulesOpenSessionRefusal(same, peer)).toBeNull();
    expect(teamRulesOpenSessionRefusal(active({ reach: { machines: "none" } }), peer)?.reason).toBe(
      "machines",
    );
    expect(teamRulesOpenSessionRefusal(active({ reach: { phones: false } }), phone)?.reason).toBe(
      "reach",
    );
  });

  it("names the machine it refuses", () => {
    const state = active({ reach: { machines: "same-rules" } });
    expect(
      teamRulesSessionRefusal(state, { ...peer, label: "Mac M1" }, "other")?.message,
    ).toContain("Mac M1");
  });

  it("refuses nothing during a hold, so the machine can be repaired", () => {
    expect(teamRulesSessionRefusal(hold, phone)).toBeNull();
    expect(teamRulesSessionRefusal(hold, peer)).toBeNull();
  });

  it("reads the fingerprint a calling machine sent", () => {
    expect(callerFingerprint({ [TEAM_RULES_FINGERPRINT_HEADER]: "3a9f" })).toBe("3a9f");
    expect(callerFingerprint({})).toBeUndefined();
  });
});
