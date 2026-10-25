import type {
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
  ProjectId,
} from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { offeredProjects, ownerUnavailable, systemKey } from "../systems/reviewModel";
import { SYSTEMS } from "../systems/fixtureData";
import {
  decodeChoice,
  effectiveChoice,
  encodeChoice,
  resolveChoice,
  systemOptions,
  type SystemChoice,
} from "./creationSystem";
import { foundSystemFacts, paintableSwatches, type FoundSystem } from "./foundSystems";
import { byRecentActivity } from "./galleryModel";

const cosmos: DesignOwnerInput = { kind: "project", projectId: "cosmos-app" as ProjectId };
const atlas: DesignOwnerInput = { kind: "project", projectId: "atlas-web" as ProjectId };

const found = (key: string): FoundSystem => ({
  key,
  name: key,
  description: null,
  paths: [`${key}/tokens.css`],
  sources: [{ path: `${key}/tokens.css`, tokens: 10, components: 0 }],
  tokens: 10,
  components: 2,
  modes: ["light", "dark"],
  swatches: [],
  copies: [],
});

const done = (...keys: string[]) =>
  ({ status: "done", found: keys.map(found), truncated: false }) as const;

describe("systemOptions", () => {
  it("offers found systems only to a project without systems of its own", () => {
    expect(
      systemOptions({ systems: SYSTEMS, owner: cosmos, scan: done("uikit"), canCopy: true }).found,
    ).toHaveLength(1);
    const owned = systemOptions({
      systems: SYSTEMS,
      owner: atlas,
      scan: done("uikit"),
      canCopy: true,
    });
    expect(owned.found).toEqual([]);
    expect(owned.own.length).toBeGreaterThan(0);
    expect(
      systemOptions({
        systems: SYSTEMS,
        owner: { kind: "playground" },
        scan: done("uikit"),
        canCopy: false,
      }),
    ).toMatchObject({ found: [], others: [] });
  });
});

describe("effectiveChoice defaults", () => {
  it("starts a project's design with its own confirmed system, not a found one", () => {
    const owned = systemOptions({
      systems: SYSTEMS,
      owner: atlas,
      scan: done("uikit"),
      canCopy: true,
    });
    const newest = owned.own.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!;
    expect(effectiveChoice(null, owned)).toEqual({ kind: "own", systemId: newest.ref.systemId });
    expect(effectiveChoice({ kind: "none" }, owned)).toEqual({ kind: "none" });
  });

  it("keeps no default in the Playground", () => {
    const playground = systemOptions({
      systems: SYSTEMS,
      owner: { kind: "playground" },
      scan: null,
      canCopy: true,
    });
    expect(effectiveChoice(null, playground)).toBeNull();
  });
});

describe("effectiveChoice", () => {
  const options = systemOptions({
    systems: SYSTEMS,
    owner: cosmos,
    scan: done("uikit", "snap"),
    canCopy: true,
  });

  it("defaults to the best found system until the person picks", () => {
    expect(effectiveChoice(null, options)).toEqual({ kind: "found", key: "uikit" });
    expect(effectiveChoice({ kind: "none" }, options)).toEqual({ kind: "none" });
    expect(effectiveChoice({ kind: "found", key: "snap" }, options)).toEqual({
      kind: "found",
      key: "snap",
    });
  });

  it("falls back when the choice is no longer offered", () => {
    expect(effectiveChoice({ kind: "found", key: "gone" }, options)).toEqual({
      kind: "found",
      key: "uikit",
    });
    expect(
      effectiveChoice({ kind: "copy", key: "p:nowhere:x" }, { own: [], found: [], others: [] }),
    ).toBeNull();
  });

  it("round-trips through the select value, keys with colons included", () => {
    const choices: SystemChoice[] = [
      { kind: "none" },
      { kind: "own", systemId: "weave" as DesignSystemId },
      { kind: "found", key: "pkg:repositories/acme/uikit" },
      { kind: "copy", key: systemKey(SYSTEMS[0]!) },
    ];
    for (const choice of choices) expect(decodeChoice(encodeChoice(choice))).toEqual(choice);
    expect(decodeChoice(null)).toBeNull();
  });
});

describe("resolveChoice", () => {
  const options = systemOptions({ systems: SYSTEMS, owner: cosmos, scan: null, canCopy: true });
  const source = options.others[0]!;
  const copy = vi.fn(async (_system: DesignSystemSummary) => ({
    ok: true as const,
    systemId: "copied" as DesignSystemId,
    name: source.name,
  }));

  it("copies only when asked, once per source and owner", async () => {
    const copied = new Map();
    const choice: SystemChoice = { kind: "copy", key: systemKey(source) };
    const first = await resolveChoice({ choice, options, owner: cosmos, copy, copied });
    const second = await resolveChoice({ choice, options, owner: cosmos, copy, copied });
    expect(first).toEqual({ ok: true, designSystem: "copied", name: source.name, found: null });
    expect(second).toEqual(first);
    expect(copy).toHaveBeenCalledOnce();
  });

  it("reports a refused copy and creates nothing with it", async () => {
    const refused = await resolveChoice({
      choice: { kind: "copy", key: systemKey(source) },
      options,
      owner: cosmos,
      copy: async () => ({ ok: false, message: "The design system was not copied." }),
      copied: new Map(),
    });
    expect(refused).toEqual({ ok: false, message: "The design system was not copied." });
  });

  it("passes a found system through without writing anything", async () => {
    const withFound = systemOptions({
      systems: [],
      owner: cosmos,
      scan: done("uikit"),
      canCopy: false,
    });
    const resolved = await resolveChoice({
      choice: { kind: "found", key: "uikit" },
      options: withFound,
      owner: cosmos,
      copy: null,
      copied: new Map(),
    });
    expect(resolved).toMatchObject({ ok: true, designSystem: null, found: { key: "uikit" } });
  });
});

describe("found system presentation", () => {
  it("reads counts and modes as a sentence", () => {
    expect(foundSystemFacts({ tokens: 283, components: 321, modes: ["light", "dark"] })).toBe(
      "283 tokens, 321 components, light and dark modes",
    );
    expect(foundSystemFacts({ tokens: 1, components: 0, modes: ["default"] })).toBe(
      "1 token, default mode",
    );
  });

  it("paints plain colors only", () => {
    const swatches = paintableSwatches({
      swatches: [
        { name: "a", value: "#1d4ed8", darkValue: "oklch(70% 0.1 250)" },
        { name: "b", value: "url(https://example.invalid/x.png)" },
        { name: "c", value: "rgb(0 0 0 / 50%)", darkValue: "expression(alert(1))" },
        { name: "d", value: "var(--other)" },
      ],
    });
    expect(swatches).toEqual([
      { name: "a", value: "#1d4ed8", darkValue: "oklch(70% 0.1 250)" },
      { name: "c", value: "rgb(0 0 0 / 50%)" },
    ]);
  });
});

describe("creation pickers offer only the person's own projects (AC-04)", () => {
  const projects = [
    { id: "a" as ProjectId, title: "Atlas", kind: "code" as const },
    { id: "b" as ProjectId, title: "Aide", kind: "personal" as const },
    { id: "c" as ProjectId, title: "Old", unavailable: "Archived project, not available here" },
    {
      id: "d" as ProjectId,
      title: "Run check",
      unavailable: "Automated project, not available here",
    },
  ];

  it("keeps personal projects for Save in and code projects for scans", () => {
    expect(offeredProjects(projects).map((project) => project.id)).toEqual(["a", "b"]);
    expect(offeredProjects(projects, "code").map((project) => project.id)).toEqual(["a"]);
  });

  it("names why a current owner is not offered", () => {
    expect(ownerUnavailable({ kind: "project", projectId: "c" as ProjectId }, projects)).toBe(
      "Archived project, not available here",
    );
    expect(ownerUnavailable({ kind: "project", projectId: "a" as ProjectId }, projects)).toBeNull();
    expect(ownerUnavailable({ kind: "playground" }, projects)).toBeNull();
  });

  it("orders projects by their latest design or own change", () => {
    const ordered = byRecentActivity(
      [
        { id: "a" as ProjectId, title: "Atlas", updatedAt: "2026-10-01T00:00:00Z" },
        { id: "b" as ProjectId, title: "Borealis", updatedAt: "2026-10-20T00:00:00Z" },
        { id: "c" as ProjectId, title: "Cosmos" },
      ],
      [
        {
          ref: { owner: { kind: "project", projectId: "a" } },
          updatedAt: "2026-10-23T00:00:00Z",
        } as never,
      ],
    );
    expect(ordered.map((project) => project.title)).toEqual(["Atlas", "Borealis", "Cosmos"]);
  });
});
