import { EnvironmentId, TEAM_RULES_FINGERPRINT_HEADER } from "@specweave-studio/contracts";
import { parseTeamRulesText, type TeamRulesState } from "@specweave-studio/shared/teamRules";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a real key file for the link.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import { FleetError } from "../studioFleet.ts";
import { loadOrCreateFleetProofKey } from "./fleetProofKey.ts";
import {
  fleetAuthorization,
  fleetReachMayBeRemembered,
  makeFleetAddressBook,
  makeFleetLink,
  reachFleetMachine,
  type FleetLink,
} from "./fleetTransport.ts";

const TAILNET = "https://m1.fixture.ts.net";
const CONNECT = "https://prod-0123456789abcdef.spec-weave.com";
const target = {
  id: "m1",
  environmentId: EnvironmentId.make("env-m1"),
  url: TAILNET,
  connectUrl: CONNECT,
};

const active = (body: Record<string, unknown>): TeamRulesState => {
  const parsed = parseTeamRulesText(JSON.stringify({ version: 1, owner: "Acme", ...body }));
  if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
  return { status: "active", rules: parsed.rules, fingerprint: "3a9f", warnings: [] };
};
const token = (jkt?: string) =>
  `${Buffer.from(JSON.stringify({ sid: "s1", ...(jkt ? { jkt } : {}) })).toString("base64url")}.sig`;

/** A machine that says what its rules are; `said` can change between calls. */
function machine(said: { teamRules?: unknown; teamRulesCarried?: boolean }) {
  return vi.fn<typeof fetch>(async (url) => {
    const at = new URL(String(url));
    if (at.pathname === "/.well-known/studio/environment")
      return Response.json({
        environmentId: "env-m1",
        label: "Mac M1",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.1.0-test",
        orchestrationProtocolVersion: 2,
        capabilities: {
          repositoryIdentity: true,
          ...(said.teamRulesCarried === undefined
            ? {}
            : { teamRulesCarried: said.teamRulesCarried }),
        },
        ...(said.teamRules === undefined ? {} : { teamRules: said.teamRules }),
      });
    return Response.json({ ok: true });
  });
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});

async function linkUnder(fetcher: typeof fetch, state: TeamRulesState) {
  const baseDir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "studio-fleet-rules-"));
  dirs.push(baseDir);
  const key = await loadOrCreateFleetProofKey(baseDir);
  const link: FleetLink = {
    ...makeFleetLink({ fetch: fetcher, baseDir, book: makeFleetAddressBook() }),
    teamRules: () => state,
  };
  return { link, bound: token(key.thumbprint) };
}

const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => error as FleetError,
  );

describe("fleet reach under Team rules", () => {
  it("refuses a credentialed call under none, without touching the network", async () => {
    const f = machine({});
    const { link, bound } = await linkUnder(f, active({ reach: { machines: "none" } }));
    const refused = await refusalOf(reachFleetMachine(link, target, { token: bound }));
    expect(refused.kind).toBe("team-rules");
    expect(refused.message).toContain("Acme");
    expect(f).not.toHaveBeenCalled();
  });

  it("still probes with no credential under none, so Machines stays truthful", async () => {
    const f = machine({});
    const { link } = await linkUnder(f, active({ reach: { machines: "none" } }));
    expect((await reachFleetMachine(link, target)).machineName).toBe("Mac M1");
  });

  it("same-rules takes the same fingerprint and refuses a different one by name", async () => {
    const state = active({ reach: { machines: "same-rules" } });
    const f = machine({ teamRules: { status: "active", fingerprint: "3a9f" } });
    const { link, bound } = await linkUnder(f, state);
    const reached = await reachFleetMachine(link, target, { token: bound });
    expect(reached.peerRules?.teamRules?.fingerprint).toBe("3a9f");

    const other = machine({ teamRules: { status: "active", fingerprint: "other" } });
    const second = await linkUnder(other, state);
    const refused = await refusalOf(
      reachFleetMachine(second.link, target, { token: second.bound }),
    );
    expect(refused.kind).toBe("team-rules");
    expect(refused.message).toContain("Mac M1");
  });

  it("same-rules refuses an older machine that names no rules", async () => {
    const { link, bound } = await linkUnder(
      machine({}),
      active({ reach: { machines: "same-rules" } }),
    );
    expect((await refusalOf(reachFleetMachine(link, target, { token: bound }))).kind).toBe(
      "team-rules",
    );
  });

  it("same-rules asks again on every call, past the identity cache", async () => {
    const said: { teamRules: unknown } = { teamRules: { status: "active", fingerprint: "3a9f" } };
    const { link, bound } = await linkUnder(
      machine(said),
      active({ reach: { machines: "same-rules" } }),
    );
    await reachFleetMachine(link, target, { token: bound });
    said.teamRules = { status: "active", fingerprint: "changed" };
    expect((await refusalOf(reachFleetMachine(link, target, { token: bound }))).kind).toBe(
      "team-rules",
    );
  });

  it("trusts an earlier reach only with no machine rule", async () => {
    const free = await linkUnder(machine({}), active({}));
    expect(fleetReachMayBeRemembered(free.link)).toBe(true);
    for (const machines of ["none", "same-rules"]) {
      const ruled = await linkUnder(machine({}), active({ reach: { machines } }));
      expect(fleetReachMayBeRemembered(ruled.link)).toBe(false);
    }
  });

  it("drops Connect addresses when Connect is off", async () => {
    const f = machine({});
    const { link, bound } = await linkUnder(f, active({ reach: { connect: false } }));
    const key = await reachFleetMachine(link, target, { token: bound }).catch(
      (error: unknown) => error,
    );
    // The token is bound, so only the tailnet remains, and nothing went to Connect.
    expect(key instanceof FleetError ? key.kind : "reached").not.toBe("team-rules");
    expect(f.mock.calls.every(([url]) => !String(url).startsWith(CONNECT))).toBe(true);
  });

  it("remembers whether a machine can hold a carried ceiling", async () => {
    const newer = await linkUnder(machine({ teamRulesCarried: true }), active({}));
    expect(
      (await reachFleetMachine(newer.link, target, { token: newer.bound })).peerRules?.carried,
    ).toBe(true);
    const older = await linkUnder(machine({}), active({}));
    expect(
      (await reachFleetMachine(older.link, target, { token: older.bound })).peerRules?.carried,
    ).toBe(false);
  });

  it("rejects a remembered Connect route after policy changes and discovers the tailnet", async () => {
    let rules = active({});
    const fixture = await linkUnder(machine({}), rules);
    const link = { ...fixture.link, teamRules: () => rules };
    const { bound } = fixture;
    const address = await reachFleetMachine(link, target, { token: bound });
    expect(address.transport).toBe("connect");
    expect(fleetReachMayBeRemembered(link)).toBe(true);

    rules = active({ reach: { connect: false } });
    expect(fleetReachMayBeRemembered(link)).toBe(false);
    expect(
      (await refusalOf(fleetAuthorization(link, address, "POST", `${address.origin}/x`, bound)))
        .kind,
    ).toBe("team-rules");
    const fallback = await reachFleetMachine(link, target, { token: bound });
    expect(fallback.transport).toBe("tailnet");
    await expect(
      fleetAuthorization(link, fallback, "POST", `${fallback.origin}/x`, bound),
    ).resolves.toHaveProperty("dpop");
  });

  it("names this machine's rules on a credentialed call", async () => {
    const { link, bound } = await linkUnder(machine({}), active({}));
    const address = await reachFleetMachine(link, target, { token: bound });
    const headers = await fleetAuthorization(link, address, "POST", `${address.origin}/x`, bound);
    expect(headers[TEAM_RULES_FINGERPRINT_HEADER]).toBe("3a9f");
  });
});
