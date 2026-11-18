import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addSource,
  listedSources,
  missingTrackSource,
  removeSource,
  sourceCandidates,
} from "./modelSources.ts";
import { moveSource } from "./modelTrackRules.ts";

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

const pid = (id: string) => ProviderInstanceId.make(id);
const ids = (rows: ReadonlyArray<{ provider: ServerProvider }>) =>
  rows.map((row) => row.provider.instanceId as string);

const codex = provider("codex", "codex", ["gpt-6.1-sol"]);
const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"]);
const copilot = provider("acpRegistry_copilot", "acpRegistry", ["claude-opus-5.5", "gpt-6.1-sol"], {
  iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
});
// Off with no CLI: no models, nothing checked.
const museOff = provider("muse", "muse", [], { enabled: false, installed: false });
const antigravityOff = provider("antigravity", "antigravity", [], {
  enabled: false,
  installed: false,
});
const museMissing = provider("muse", "muse", [], { installed: false, status: "error" });
const cursorSignedOut = provider("cursor", "cursor", [], {
  auth: { status: "unauthenticated" },
  status: "error",
});
// An agent from the registry that reports no usage: billing unknown, never picked on its own.
const held = provider("acpRegistry_kimi", "acpRegistry", ["kimi-k3"]);
const broken = provider("pi", "pi", ["default"], {
  availability: "unavailable",
  unavailableReason: "Not on this platform",
});

describe("listedSources", () => {
  it("lists the sources picked automatically while nothing is saved", () => {
    const rows = listedSources({ providers: [codex, claude, held, museOff], nowMs: now });
    // The registry agent has unknown billing and Muse is off: neither is in the built-in order.
    expect(ids(rows)).toEqual(["codex", "claudeAgent"]);
  });

  it("lists exactly the saved order once saved, off sources included", () => {
    const rows = listedSources({
      providers: [codex, claude, copilot, museOff],
      order: [pid("muse"), pid("codex"), pid("gone-elsewhere")],
      nowMs: now,
    });
    expect(ids(rows)).toEqual(["muse", "codex"]);
    expect(rows[0]!.status.state).toBe("off");
  });

  it("never lists a provider this machine cannot run", () => {
    const rows = listedSources({
      providers: [codex, broken],
      order: [pid("pi"), pid("codex")],
      nowMs: now,
    });
    expect(ids(rows)).toEqual(["codex"]);
  });
});

describe("addSource and removeSource", () => {
  it("the first add from the built-in order saves what was shown plus the new source", () => {
    const providers = [codex, claude, copilot, museOff];
    const rows = listedSources({ providers, nowMs: now });
    expect(addSource({ rows, order: [], provider: museOff })).toEqual([
      "codex",
      "claudeAgent",
      "acpRegistry_copilot",
      "muse",
    ]);
  });

  it("adds an automatic source above held ones and keeps ids this machine lacks", () => {
    const providers = [codex, claude, held, copilot];
    const order = [pid("codex"), pid("acpRegistry_kimi"), pid("other-machine")];
    const rows = listedSources({ providers, order, nowMs: now });
    expect(ids(rows)).toEqual(["codex", "acpRegistry_kimi"]);
    expect(addSource({ rows, order, provider: copilot })).toEqual([
      "codex",
      "acpRegistry_copilot",
      "acpRegistry_kimi",
      "other-machine",
    ]);
  });

  it("adds a held source last, where naming it only lets a thread continue on it", () => {
    const order = [pid("codex")];
    const rows = listedSources({ providers: [codex, held], order, nowMs: now });
    expect(addSource({ rows, order, provider: held })).toEqual(["codex", "acpRegistry_kimi"]);
  });

  it("removing a built-in source saves the rest and leaves the provider alone", () => {
    const providers = [codex, claude, copilot];
    const rows = listedSources({ providers, nowMs: now });
    const result = removeSource({ rows, order: [], instanceId: pid("acpRegistry_copilot") });
    expect(result).toEqual({ order: ["codex", "claudeAgent"] });
    expect(copilot.enabled).toBe(true);
    // Removed, it is offered again under Add source.
    const after = "order" in result ? result.order : [];
    expect(ids(sourceCandidates({ providers, order: after, nowMs: now }))).toEqual([
      "acpRegistry_copilot",
    ]);
  });

  it("keeps saved ids this machine lacks when removing", () => {
    const order = [pid("codex"), pid("claudeAgent"), pid("other-machine")];
    const rows = listedSources({ providers: [codex, claude], order, nowMs: now });
    expect(removeSource({ rows, order, instanceId: pid("codex") })).toEqual({
      order: ["claudeAgent", "other-machine"],
    });
  });

  it("refuses to remove the last source, which would bring back the built-in order", () => {
    const order = [pid("codex")];
    const rows = listedSources({ providers: [codex, claude], order, nowMs: now });
    expect(removeSource({ rows, order, instanceId: pid("codex") })).toEqual({
      refused: "last-source",
    });
  });

  it("reorders a saved list with the existing validation", () => {
    const order = [pid("codex"), pid("claudeAgent"), pid("acpRegistry_kimi")];
    const rows = listedSources({ providers: [codex, claude, held], order, nowMs: now });
    expect(moveSource(rows, 1, 0, order)).toEqual({
      order: ["claudeAgent", "codex", "acpRegistry_kimi"],
    });
    expect(moveSource(rows, 0, 2, order)).toEqual({ refused: "into-held" });
  });
});

describe("sourceCandidates", () => {
  it("offers every unlisted source, ready ones first, then sign-in, install and off", () => {
    const providers = [
      antigravityOff,
      museMissing,
      cursorSignedOut,
      copilot,
      codex,
      claude,
      broken,
    ];
    const rows = sourceCandidates({
      providers,
      order: [pid("codex"), pid("claudeAgent")],
      nowMs: now,
    });
    expect(ids(rows)).toEqual(["acpRegistry_copilot", "cursor", "muse", "antigravity"]);
    expect(rows.map((row) => row.status.state)).toEqual([
      "ready",
      "sign-in",
      "not-installed",
      "off",
    ]);
  });
});

describe("missingTrackSource", () => {
  it("names the maker's own harness for a Muse model, however far from ready", () => {
    const row = missingTrackSource({
      providers: [codex, claude, museMissing],
      model: "muse-wonder-full-1.0",
      nowMs: now,
    });
    expect(row?.provider.instanceId).toBe("muse");
    expect(row?.status.state).toBe("not-installed");
  });

  it("names an off source for Gemini on a machine with only Codex and Claude on", () => {
    const row = missingTrackSource({
      providers: [codex, claude, antigravityOff, museOff],
      model: "gemini-4-carbon",
      nowMs: now,
    });
    expect(row?.provider.instanceId).toBe("antigravity");
    expect(row?.status.state).toBe("off");
  });

  it("prefers a source that lists the model, even when it is off", () => {
    const cursorOff = provider("cursor", "cursor", ["gemini-4-carbon"], { enabled: false });
    const row = missingTrackSource({
      providers: [antigravityOff, cursorOff],
      model: "gemini-4-carbon",
      nowMs: now,
    });
    expect(row?.provider.instanceId).toBe("cursor");
  });

  it("names the source a saved entry pins, even when the maker's harness is also off", () => {
    const cursorOff = provider("cursor", "cursor", [], { enabled: false, installed: false });
    const row = missingTrackSource({
      providers: [antigravityOff, cursorOff],
      model: "gemini-4-carbon",
      nowMs: now,
      pinned: pid("cursor"),
    });
    expect(row?.provider.instanceId).toBe("cursor");
    expect(row?.status.state).toBe("off");
  });

  it("does not blame a ready harness that simply does not list the model", () => {
    const antigravityReady = provider("antigravity", "antigravity", ["gemini-3-pro"]);
    expect(
      missingTrackSource({
        providers: [codex, antigravityReady],
        model: "gemini-4-carbon",
        nowMs: now,
      }),
    ).toBe(null);
  });

  it("is null when nothing here could run the model", () => {
    expect(
      missingTrackSource({ providers: [codex, claude], model: "gemini-4-carbon", nowMs: now }),
    ).toBe(null);
  });
});
