import * as DateTime from "effect/DateTime";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelRoute,
  type ModelRoutes,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reviewerChain } from "./adversarialReview.ts";
import { modelOffers, sourceCost } from "./modelOffers.ts";
import {
  addRouteSource,
  allowRouteSource,
  applyRoute,
  dropRouteSource,
  moveRouteSource,
  restoreRouteSource,
  routeConsent,
  routeFor,
  togglePinRouteSource,
  withModelRoute,
} from "./modelRoutes.ts";
import { describeTrack } from "./modelTrackRules.ts";
import { defaultTrackSelections, launchTrackLanes, providersForModel } from "./modelTracks.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const now = Date.parse("2026-11-18T08:00:00.000Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...over,
  };
}

const pid = ProviderInstanceId.make;
const FABLE = "claude-fable-5-2";

// What M4 lists on November 18, 2026: Claude Code and Cursor list Fable 5.2,
// both Copilot accounts only Fable 5.
const claude = provider("claudeAgent", "claudeAgent", [FABLE, "claude-fable-5"], {
  auth: { status: "authenticated", label: "Claude Max" },
});
const cursor = provider("cursor", "cursor", [FABLE, "claude-fable-5"]);
const copilot = provider("acpRegistry_copilot", "acpRegistry", ["claude-fable-5"], {
  displayName: "Copilot Enterprise",
  iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
});
// Per token: an API key.
const openrouter = provider("openrouter", "opencode", [FABLE], {
  auth: { status: "authenticated", type: "apiKey" },
});
const machine = [claude, cursor, copilot, openrouter];

const route = (over: Partial<ModelRoute>): ModelRoute => ({
  order: [],
  dropped: [],
  pinned: false,
  allowed: [],
  ...over,
});
const routes = (over: Partial<ModelRoute>): ModelRoutes => ({ [FABLE]: route(over) });
const instances = (list: ReadonlyArray<{ readonly instanceId: string }>) =>
  list.map((entry) => entry.instanceId as string);
const complex = (lanes: ReturnType<typeof launchTrackLanes>) =>
  lanes.complex
    .filter((entry) => entry.model.startsWith("claude-fable"))
    .map((entry) => entry.instanceId as string);
const fableRow = (input: { readonly routes?: ModelRoutes; readonly saved?: ModelSelection[] }) =>
  describeTrack({
    track: "complex",
    saved: input.saved ?? [],
    providers: machine,
    nowMs: now,
    routes: input.routes,
  }).find((row) => row.model.startsWith("claude-fable"))!;
const used = (row: ReturnType<typeof fableRow>) =>
  row.sources.filter((source) => source.used).map((source) => source.provider.instanceId as string);

describe("today's automatic order", () => {
  it("takes every enabled source that lists the model: Claude first as its maker, then Cursor", () => {
    expect(
      instances(
        providersForModel({ providers: machine, model: { slug: FABLE } }).map((c) => c.provider),
      ),
    ).toEqual(["claudeAgent", "cursor", "openrouter"]);
    expect(used(fableRow({}))).toEqual(["claudeAgent", "cursor"]);
  });

  it("never lets Copilot's older Fable 5 stand in for Fable 5.2 while a source lists 5.2", () => {
    const family = providersForModel({ providers: machine, model: { slug: FABLE }, family: true });
    expect(family.map((choice) => `${choice.provider.instanceId}:${choice.slug}`)).toEqual([
      "claudeAgent:claude-fable-5-2",
      "cursor:claude-fable-5-2",
      "openrouter:claude-fable-5-2",
    ]);
    expect(complex(launchTrackLanes(null, machine, null, now))).toEqual(["claudeAgent", "cursor"]);
  });

  it("still lets an older release stand in where nothing lists the model or a newer one", () => {
    const family = providersForModel({
      providers: [copilot],
      model: { slug: FABLE },
      family: true,
    });
    expect(family.map((choice) => choice.slug)).toEqual(["claude-fable-5"]);
  });
});

describe("routes", () => {
  it("finds a route under any spelling of the model and treats an empty one as automatic", () => {
    const saved = withModelRoute(
      {},
      { slug: "claude-fable-5.2" },
      route({ dropped: [pid("cursor")] }),
    );
    expect(Object.keys(saved)).toEqual([FABLE]);
    expect(routeFor(saved, { slug: FABLE })?.dropped).toEqual(["cursor"]);
    expect(routeFor(withModelRoute(saved, { slug: FABLE }, route({})), { slug: FABLE })).toBeNull();
  });

  it("orders the model's sources the person's way, on the page and at launch", () => {
    const saved = routes({ order: [pid("cursor"), pid("claudeAgent")] });
    expect(used(fableRow({ routes: saved }))).toEqual(["cursor", "claudeAgent"]);
    expect(complex(launchTrackLanes(null, machine, null, now, { routes: saved }))).toEqual([
      "cursor",
      "claudeAgent",
    ]);
  });

  it("puts a route's order ahead of the source a saved entry names", () => {
    const saved = routes({ order: [pid("cursor")] });
    const entry = { instanceId: pid("claudeAgent"), model: FABLE };
    expect(used(fableRow({ routes: saved, saved: [entry] }))).toEqual(["cursor", "claudeAgent"]);
    expect(
      complex(
        launchTrackLanes({ complex: [entry], routine: [] }, machine, null, now, { routes: saved }),
      ),
    ).toEqual(["cursor", "claudeAgent"]);
  });

  it("never runs the model on a dropped source, even one a saved entry names", () => {
    const saved = routes({ dropped: [pid("cursor")] });
    const entry = { instanceId: pid("cursor"), model: FABLE };
    expect(used(fableRow({ routes: saved }))).toEqual(["claudeAgent"]);
    expect(used(fableRow({ routes: saved, saved: [entry] }))).toEqual(["claudeAgent"]);
    expect(
      complex(
        launchTrackLanes({ complex: [entry], routine: [] }, machine, null, now, { routes: saved }),
      ),
    ).toEqual(["claudeAgent"]);
    // Review honours the drop too (per-token sources there are still filtered when a reviewer is picked).
    const reviewers = reviewerChain({
      providers: machine,
      reviewers: [entry],
      tier: "regular",
      routes: saved,
    });
    expect(instances(reviewers)[0]).toBe("claudeAgent");
    expect(instances(reviewers)).not.toContain("cursor");
  });

  it("runs a pinned model on its pinned source alone", () => {
    const saved = routes({ order: [pid("cursor")], pinned: true });
    expect(used(fableRow({ routes: saved }))).toEqual(["cursor"]);
    expect(complex(launchTrackLanes(null, machine, null, now, { routes: saved }))).toEqual([
      "cursor",
    ]);
    // A pin on a source that cannot serve the model leaves the model to the next one.
    const gone = routes({ order: [pid("missing")], pinned: true });
    expect(
      defaultTrackSelections("complex", machine, null, gone).some((entry) => entry.model === FABLE),
    ).toBe(false);
  });

  it("edits a route: move, drop, restore, pin and unpin, add a paid source", () => {
    const shown = [pid("claudeAgent"), pid("cursor")];
    expect(moveRouteSource(null, shown, 1, 0).order).toEqual(["cursor", "claudeAgent"]);
    const dropped = dropRouteSource(route({ order: shown, pinned: true }), pid("claudeAgent"));
    expect(dropped).toEqual(
      route({ order: [pid("cursor")], dropped: [pid("claudeAgent")], pinned: false }),
    );
    expect(restoreRouteSource(dropped, pid("claudeAgent")).dropped).toEqual([]);
    const pinned = togglePinRouteSource(null, shown, pid("cursor"));
    expect(pinned).toEqual(route({ order: [pid("cursor"), pid("claudeAgent")], pinned: true }));
    expect(togglePinRouteSource(pinned, shown, pid("cursor")).pinned).toBe(false);
    expect(addRouteSource(null, shown, pid("openrouter")).order).toEqual([
      "claudeAgent",
      "cursor",
      "openrouter",
    ]);
  });

  it("applies a route over any list of choices", () => {
    const list = [
      { provider: { instanceId: "a" } },
      { provider: { instanceId: "b" } },
      { provider: { instanceId: "c" } },
    ];
    expect(
      applyRoute(list, route({ order: [pid("c")], dropped: [pid("a")] })).map(
        (c) => c.provider.instanceId,
      ),
    ).toEqual(["c", "b"]);
  });
});

describe("paid sources ask first", () => {
  const listed = routes({ order: [pid("claudeAgent"), pid("cursor"), pid("openrouter")] });

  it("says how each source may run the model", () => {
    const fable = routeFor(listed, { slug: FABLE });
    expect(routeConsent(fable, pid("cursor"), false)).toBe("plan");
    expect(routeConsent(fable, pid("openrouter"), true)).toBe("ask");
    expect(routeConsent(null, pid("openrouter"), true)).toBe("never");
    expect(routeConsent(allowRouteSource(fable, pid("openrouter")), pid("openrouter"), true)).toBe(
      "allowed",
    );
  });

  it("never runs a per-token source silently: left out without a way to ask", () => {
    expect(complex(launchTrackLanes(null, machine, null, now))).not.toContain("openrouter");
    expect(complex(launchTrackLanes(null, machine, null, now, { routes: listed }))).toEqual([
      "claudeAgent",
      "cursor",
    ]);
  });

  it("brings a listed per-token source along for a caller that asks first", () => {
    expect(
      complex(launchTrackLanes(null, machine, null, now, { routes: listed, askable: true })),
    ).toEqual(["claudeAgent", "cursor", "openrouter"]);
    const row = fableRow({ routes: listed });
    expect(row.sources.find((source) => source.provider.instanceId === "openrouter")).toMatchObject(
      { used: true, ask: true },
    );
  });

  it("runs it without asking once always allowed for the model", () => {
    const allowed = {
      [FABLE]: allowRouteSource(routeFor(listed, { slug: FABLE }), pid("openrouter")),
    };
    expect(complex(launchTrackLanes(null, machine, null, now, { routes: allowed }))).toEqual([
      "claudeAgent",
      "cursor",
      "openrouter",
    ]);
    expect(
      fableRow({ routes: allowed }).sources.find((s) => s.provider.instanceId === "openrouter")
        ?.ask,
    ).toBe(false);
  });

  it("keeps a route through a settings save, replacing its lists", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { modelRoutes: listed });
    const next = applyServerSettingsPatch(first, {
      modelRoutes: { [FABLE]: route({ dropped: [pid("cursor")] }) },
    });
    expect(next.modelRoutes[FABLE]).toEqual(route({ dropped: [pid("cursor")] }));
  });
});

describe("available via", () => {
  const devinAbsent = machine;
  const devinNoCatalog = [
    ...machine,
    provider("acpRegistry_devin", "acpRegistry", [], {
      installed: false,
      status: "error",
      iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/devin.svg",
    }),
  ];
  const devinOtherModels = [
    ...machine,
    provider("acpRegistry_devin", "acpRegistry", ["swe-2-flash-medium"], { displayName: "Devin" }),
  ];
  const offers = (list: ReadonlyArray<ServerProvider>) =>
    modelOffers(list, { slug: FABLE }).map((offer) =>
      offer.kind === "absent"
        ? `absent:${offer.source}`
        : `${offer.provider.instanceId}:${offer.listed ? "listed" : "table"}`,
    );

  it("lists the sources that offer Fable 5.2, and never Copilot", () => {
    expect(offers(devinAbsent)).toEqual([
      "claudeAgent:listed",
      "cursor:listed",
      "openrouter:listed",
      "absent:devin",
    ]);
  });

  it("answers from the table only for a source with no catalog here", () => {
    expect(offers(devinNoCatalog)).toEqual([
      "claudeAgent:listed",
      "cursor:listed",
      "openrouter:listed",
      "acpRegistry_devin:table",
    ]);
    expect(offers(devinOtherModels)).toEqual([
      "claudeAgent:listed",
      "cursor:listed",
      "openrouter:listed",
    ]);
  });

  it("names Copilot only for the Fable it lists", () => {
    expect(offers([copilot])).toEqual(["absent:claudeAgent", "absent:cursor", "absent:devin"]);
    expect(
      modelOffers([copilot], { slug: "claude-fable-5" }).flatMap((offer) =>
        offer.kind === "provider" ? [offer.provider.instanceId] : [],
      ),
    ).toEqual(["acpRegistry_copilot"]);
  });

  it("says what each source costs", () => {
    expect(sourceCost(claude, FABLE)).toEqual({ kind: "plan", plan: "Claude Max" });
    expect(sourceCost(cursor, FABLE)).toEqual({ kind: "credits" });
    expect(sourceCost(openrouter, FABLE)).toEqual({ kind: "per-token" });
  });
});
