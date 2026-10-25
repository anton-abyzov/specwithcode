import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { gitHubRoutingConnectionKey } from "./githubRoutingPermissions.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  credentialConnectionId,
  insertRoute,
  entryWithRoutes,
  mergeLearnedRoutes,
  removedWithRelay,
  routesAfterRemoving,
  upsertRoute,
} from "./routes.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function direct(id: string, httpBaseUrl: string): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      connectionId: id,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: ENVIRONMENT_ID,
        label: "Desk",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  };
}

const RELAY: ConnectionRoute = {
  target: new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Desk" }),
  profile: Option.none(),
};
const LAN = direct("lan", "http://192.168.1.10:8319/");
const TAILNET = direct("tailnet", "https://desk.tail1234.ts.net/");
const PUBLIC = direct("public", "https://desk.example.com/");

describe("connection routes", () => {
  it("classifies direct routes by address", () => {
    expect(connectionRouteKind(LAN)).toBe("lan");
    expect(connectionRouteKind(direct("ip", "http://100.101.102.103:8319/"))).toBe("tailnet");
    expect(connectionRouteKind(TAILNET)).toBe("tailnet");
    expect(connectionRouteKind(PUBLIC)).toBe("public");
    expect(connectionRouteKind(direct("lo", "http://127.0.0.1:8319/"))).toBe("loopback");
    expect(connectionRouteKind(direct("ts6", "http://[fd7a:115c:a1e0::1]:8319/"))).toBe("tailnet");
    expect(connectionRouteLabel(TAILNET)).toBe("Tailscale");
    expect(connectionRouteLabel(RELAY)).toBe("SpecWithCode Connect");
  });

  it("places a new route after faster kinds and ahead of SpecWithCode Connect", () => {
    expect(insertRoute([RELAY], LAN)).toEqual([LAN, RELAY]);
    expect(insertRoute([LAN, RELAY], TAILNET)).toEqual([LAN, TAILNET, RELAY]);
    expect(insertRoute([TAILNET], LAN)).toEqual([LAN, TAILNET]);
    expect(insertRoute([LAN, TAILNET], RELAY)).toEqual([LAN, TAILNET, RELAY]);
  });

  it("keeps a user's order when a saved route is replaced", () => {
    // The user preferred Studio Connect over the LAN; re-pairing the LAN keeps that.
    const repaired = direct("lan", "http://192.168.1.11:8319/");
    expect(upsertRoute([RELAY, LAN], repaired)).toEqual([RELAY, repaired]);
  });
});

describe("learned routes", () => {
  it("does not learn plain HTTP routes that would borrow a paired bearer", () => {
    const paired = { ...relayOnly, target: PUBLIC.target, profile: PUBLIC.profile };
    expect(
      mergeLearnedRoutes({
        entry: paired,
        activeRoute: PUBLIC,
        reported: [{ httpBaseUrl: "http://192.168.1.10:8319/" }],
        allowInsecure: true,
      }),
    ).toBeNull();
  });

  it("prunes previously learned insecure bearer routes while retaining the paired route", () => {
    const profile = new BearerConnectionProfile({
      connectionId: "lan",
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      httpBaseUrl: "http://192.168.1.10:8319/",
      wsBaseUrl: "ws://192.168.1.10:8319/",
      learned: true,
    });
    const stale = { ...LAN, profile: Option.some(profile) };
    const paired = {
      ...relayOnly,
      target: PUBLIC.target,
      profile: PUBLIC.profile,
      alternateRoutes: [stale],
    };
    expect(
      mergeLearnedRoutes({
        entry: paired,
        activeRoute: PUBLIC,
        reported: [{ httpBaseUrl: profile.httpBaseUrl }],
        allowInsecure: true,
      }),
    ).toEqual([PUBLIC]);
  });

  it("keeps a learned SpecWithCode Connect route on plain HTTP while connected over the paired bearer", () => {
    const proofBound = new BearerConnectionProfile({
      connectionId: "lan",
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      httpBaseUrl: "http://192.168.1.10:8319/",
      wsBaseUrl: "ws://192.168.1.10:8319/",
      learned: true,
      authorization: "studio-connect",
    });
    const lan = { ...LAN, profile: Option.some(proofBound) };
    const paired = {
      ...relayOnly,
      target: PUBLIC.target,
      profile: PUBLIC.profile,
      alternateRoutes: [lan, RELAY],
    };
    // No bearer crosses HTTP here, so nothing is pruned and nothing changes.
    expect(
      mergeLearnedRoutes({
        entry: paired,
        activeRoute: PUBLIC,
        reported: [{ httpBaseUrl: proofBound.httpBaseUrl }],
        allowInsecure: true,
      }),
    ).toBeNull();
  });

  const relayOnly: ConnectionCatalogEntry = {
    target: RELAY.target,
    profile: RELAY.profile,
    enabled: true,
  };
  const ids = (routes: ReadonlyArray<ConnectionRoute> | null) =>
    routes?.map((route) => connectionRouteId(route.target)) ?? null;
  const profileOf = (route: ConnectionRoute) => Option.getOrThrow(route.profile);

  it("learns a LAN address over SpecWithCode Connect, ahead of it, using the SpecWithCode Connect credential", () => {
    const routes = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:8319/" }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([`learned:${ENVIRONMENT_ID}:http://192.168.1.10:8319`, "relay"]);
    expect(profileOf(routes![0]!)).toMatchObject({
      learned: true,
      authorization: "studio-connect",
      wsBaseUrl: "ws://192.168.1.10:8319/",
    });
  });

  it("replaces a learned LAN address when the server reports a new one", () => {
    const first = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:8319/" }],
      allowInsecure: true,
    })!;
    const entry: ConnectionCatalogEntry = {
      ...relayOnly,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://10.0.0.42:8319/" }],
      allowInsecure: true,
    });
    expect(ids(moved)).toEqual([`learned:${ENVIRONMENT_ID}:http://10.0.0.42:8319`, "relay"]);
  });

  it("keeps a learned route where the user moved it while the server reports it", () => {
    const lan = { httpBaseUrl: "http://192.168.1.10:8319/" };
    const first = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [lan],
      allowInsecure: true,
    })!;
    // The user prefers Studio Connect over the learned LAN address.
    const reordered = entryWithRoutes(relayOnly, [first[1]!, first[0]!]);
    expect(
      mergeLearnedRoutes({
        entry: reordered,
        activeRoute: RELAY,
        reported: [lan],
        allowInsecure: true,
      }),
    ).toBeNull();
    // A newly reported address is still placed by speed.
    const next = mergeLearnedRoutes({
      entry: reordered,
      activeRoute: RELAY,
      reported: [lan, { httpBaseUrl: "http://100.101.102.103:8319/" }],
      allowInsecure: true,
    });
    expect(ids(next)).toEqual([
      `learned:${ENVIRONMENT_ID}:http://100.101.102.103:8319`,
      "relay",
      `learned:${ENVIRONMENT_ID}:http://192.168.1.10:8319`,
    ]);
  });

  it("leaves user routes alone and does not learn an address already saved", () => {
    const entry: ConnectionCatalogEntry = {
      target: LAN.target,
      profile: LAN.profile,
      alternateRoutes: [RELAY],
      enabled: true,
    };
    expect(
      mergeLearnedRoutes({
        entry,
        activeRoute: RELAY,
        reported: [{ httpBaseUrl: "http://192.168.1.10:8319" }],
        allowInsecure: true,
      }),
    ).toBeNull();
    // The server stops reporting the LAN address; the paired route stays.
    expect(
      mergeLearnedRoutes({ entry, activeRoute: RELAY, reported: [], allowInsecure: true }),
    ).toBeNull();
  });

  it("borrows the paired token when learned over a bearer route", () => {
    const entry: ConnectionCatalogEntry = {
      ...relayOnly,
      target: LAN.target,
      profile: LAN.profile,
    };
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "https://desk.tail1234.ts.net/" }],
      allowInsecure: true,
    })!;
    const learned = routes.find((route) => connectionRouteKind(route) === "tailnet")!;
    expect(profileOf(learned)).not.toHaveProperty("authorization");
    expect(credentialConnectionId(connectionRouteId(learned.target))).toBe("lan");
  });

  it("skips plain HTTP from an HTTPS page and never learns loopback", () => {
    expect(
      mergeLearnedRoutes({
        entry: relayOnly,
        activeRoute: RELAY,
        reported: [
          { httpBaseUrl: "http://192.168.1.10:8319/" },
          { httpBaseUrl: "http://127.0.0.1:8319/" },
        ],
        allowInsecure: false,
      }),
    ).toBeNull();
  });

  it("removes learned routes along with the route whose credential they borrow", () => {
    const overRelay = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:8319/" }],
      allowInsecure: true,
    })!;
    expect(routesAfterRemoving(overRelay, "relay")).toEqual([]);

    const paired: ConnectionCatalogEntry = {
      ...relayOnly,
      target: LAN.target,
      profile: LAN.profile,
      alternateRoutes: [RELAY],
    };
    const overLan = mergeLearnedRoutes({
      entry: paired,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "https://desk.tail1234.ts.net/" }],
      allowInsecure: true,
    })!;
    expect(ids(routesAfterRemoving(overLan, "lan"))).toEqual(["relay"]);
    // Removing Studio Connect keeps the paired LAN and what it learned.
    expect(ids(routesAfterRemoving(overLan, "relay"))).toHaveLength(2);
  });

  it("counts an environment reached only through SpecWithCode Connect as removed with it", () => {
    const learned = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:8319/" }],
      allowInsecure: true,
    })!;
    expect(removedWithRelay(relayOnly)).toBe(true);
    expect(removedWithRelay(entryWithRoutes(relayOnly, learned))).toBe(true);
    expect(removedWithRelay(entryWithRoutes(relayOnly, [LAN, RELAY]))).toBe(false);
  });

  it("keeps GitHub routing trust when a route is learned", () => {
    const learned = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:8319/" }],
      allowInsecure: true,
    })!;
    const withLearned: ConnectionCatalogEntry = {
      ...relayOnly,
      target: learned[0]!.target,
      profile: learned[0]!.profile,
      alternateRoutes: learned.slice(1),
    };
    expect(gitHubRoutingConnectionKey(withLearned)).toBe(gitHubRoutingConnectionKey(relayOnly));
  });

  it("keeps the SpecWithCode Connect credential when learning over a learned SpecWithCode Connect route", () => {
    const first = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:8319/" }],
      allowInsecure: true,
    })!;
    const learnedLan = first[0]!;
    const entry: ConnectionCatalogEntry = {
      ...relayOnly,
      target: learnedLan.target,
      profile: learnedLan.profile,
      alternateRoutes: first.slice(1),
    };
    const next = mergeLearnedRoutes({
      entry,
      activeRoute: learnedLan,
      reported: [
        { httpBaseUrl: "http://192.168.1.10:8319/" },
        { httpBaseUrl: "https://desk.tail1234.ts.net/" },
      ],
      allowInsecure: true,
    })!;
    for (const route of next.filter((candidate) => connectionRouteKind(candidate) !== "relay")) {
      expect(profileOf(route)).toMatchObject({ authorization: "studio-connect" });
      expect(connectionRouteId(route.target)).not.toContain("@");
    }
  });

  it("saves a scheme change on the same host as a new address", () => {
    const first = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://desk.local:8319/" }],
      allowInsecure: true,
    })!;
    const entry: ConnectionCatalogEntry = {
      ...relayOnly,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "https://desk.local:8319/" }],
      allowInsecure: true,
    });
    expect(moved).not.toBeNull();
    expect(profileOf(moved![0]!)).toMatchObject({ httpBaseUrl: "https://desk.local:8319/" });
  });
});
