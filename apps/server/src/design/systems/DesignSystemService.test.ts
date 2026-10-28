// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DesignError,
  type DesignOwnerInput,
  type DesignSystem,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  MAX_PROPOSALS_PER_ACTOR,
  DesignSystemFiles,
  DesignSystemProposals,
  DesignSystemRoots,
  DesignSystemService,
  type DesignSystemCaller,
  makeDesignSystemService,
  userCaller,
} from "./DesignSystemService.ts";
import type { PreviewBuilder } from "./previews/buildPreviews.ts";
import {
  STATUS_COPY,
  UIKIT,
  UIKIT_BARREL,
  UIKIT_TOKENS,
  layOutUmbrella,
} from "./umbrellaFixture.testkit.ts";

const withWrite = (roots: Pick<typeof DesignSystemRoots.Service, "resolve">) =>
  DesignSystemRoots.of({ ...roots, resolveForWrite: roots.resolve });

const temps: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<DesignSystemService, never>> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const path of temps.splice(0)) await NodeFSP.rm(path, { recursive: true, force: true });
});

const fixture = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", name), "utf8");

const PROJECT = ProjectId.make("project-a");
const OTHER = ProjectId.make("project-b");
const project: DesignOwnerInput = { kind: "project", projectId: PROJECT };
const agent = (scope: DesignOwnerInput): DesignSystemCaller => ({
  actor: { kind: "agent", threadId: ThreadId.make("thread-1") },
  audience: "agents",
  scope,
});

/** An in-memory store with the design store's compare-and-set rules. */
const memoryFiles = () => {
  const systems = new Map<string, DesignSystem>();
  const writes: Array<{ root: string; id: string; expectedRevision: number | null }> = [];
  /** Stored files by `<root>|<system id>`, then by path. */
  const storedFiles = new Map<string, Map<string, Uint8Array>>();
  const service = DesignSystemFiles.of({
    listDesignSystems: async (root) => ({
      systems: [...systems.entries()]
        .filter(([key]) => key.startsWith(`${root}|`))
        .map(([, system]) => system),
      problems: [],
    }),
    readDesignSystem: async (root, id) => {
      const system = systems.get(`${root}|${id}`);
      if (!system) throw Object.assign(new Error(`${id} not found`), { code: "not_found" });
      return system;
    },
    writeDesignSystem: async (root, system, options) => {
      const key = `${root}|${system.id}`;
      const current = systems.get(key);
      if (
        (options.expectedRevision === null) !== (current === undefined) ||
        (current && current.revision !== options.expectedRevision)
      ) {
        throw Object.assign(new Error("conflict"), {
          code: "conflict",
          currentRevision: current?.revision,
        });
      }
      const stored = { ...system, revision: current ? current.revision + 1 : 0 };
      systems.set(key, stored);
      writes.push({ root, id: system.id, expectedRevision: options.expectedRevision });
      return stored;
    },
    listStoredFiles: async (root, id) =>
      [...(storedFiles.get(`${root}|${id}`)?.keys() ?? [])].sort(),
    putStoredFile: async (root, id, path, bytes) => {
      const key = `${root}|${id}`;
      if (!storedFiles.has(key)) storedFiles.set(key, new Map());
      storedFiles.get(key)!.set(path, bytes);
    },
  });
  return { service, systems, writes, storedFiles };
};

/** Previews without a child process: every component renders to `previews/<name>.html`. */
const fakePreviews = (files: ReturnType<typeof memoryFiles>) => {
  const builds: string[] = [];
  const stores: string[] = [];
  // Set to make the next build fail as a package without dependencies would.
  const next = { fail: false };
  const builder: PreviewBuilder = {
    build: async (realRoot, system) => {
      builds.push(`${realRoot}|${system.id}`);
      if (next.fail) {
        next.fail = false;
        return {
          files: [],
          components: new Map(
            system.components.map((component) => [
              component.id,
              { previewNote: "Previews did not build for its package. Rebuild to try again." },
            ]),
          ),
          previews: null,
          problems: ["kit: install its dependencies to build previews."],
          complete: false,
        };
      }
      return {
        files: system.components.map((component) => ({
          path: `previews/${component.name}.html`,
          bytes: new TextEncoder().encode(
            `<section data-swc-story="Default">${component.name}</section>`,
          ),
        })),
        components: new Map(
          system.components.map((component) => [
            component.id,
            { previewFile: `previews/${component.name}.html` },
          ]),
        ),
        previews: {
          stylesheetFile: "previews/preview.css",
          builtAt: "2026-10-20T12:00:00.000Z",
          rendered: system.components.length,
          total: system.components.length,
        },
        problems: [],
        complete: true,
      };
    },
    store: async (root, id, built) => {
      stores.push(id);
      for (const file of built) await files.service.putStoredFile(root, id, file.path, file.bytes);
    },
  };
  return { builder, builds, stores, next };
};

async function setup(options: { readonly permissiveRoots?: boolean } = {}) {
  const checkout = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "design-service-"));
  temps.push(checkout);
  const write = async (path: string, text: string) => {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(checkout, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(checkout, path), text);
  };
  await write("design/weave/tokens.json", fixture("weave/tokens.json.fixture"));
  await write("design/weave/weave.css", fixture("weave/weave.css.fixture"));
  const files = memoryFiles();
  const previews = fakePreviews(files);
  const roots = withWrite({
    resolve: (caller, owner) => {
      if (
        !options.permissiveRoots &&
        caller.scope !== undefined &&
        (caller.scope.kind !== owner.kind ||
          (owner.kind === "project" &&
            caller.scope.kind === "project" &&
            caller.scope.projectId !== owner.projectId))
      ) {
        return Effect.fail(
          new DesignError({ code: "forbidden", detail: "Not this thread's project." }),
        );
      }
      return Effect.succeed(
        owner.kind === "project"
          ? {
              owner: { kind: "project", environmentId: "env" as never, projectId: owner.projectId },
              designRoot: NodePath.join(checkout, ".specweave/design"),
              projectRoot: checkout,
              refPrefix: ".specweave/design/systems/",
            }
          : {
              owner: { kind: "playground", environmentId: "env" as never },
              designRoot: NodePath.join(checkout, "playground"),
              projectRoot: null,
              refPrefix: "systems/",
            },
      );
    },
  });
  const layer = Layer.effect(
    DesignSystemService,
    makeDesignSystemService({
      figmaEndpoint: "http://127.0.0.1:9/mcp",
      now: () => "2026-10-20T12:00:00.000Z",
      previews: previews.builder,
    }),
  ).pipe(
    Layer.provide(Layer.succeed(DesignSystemRoots, roots)),
    Layer.provide(Layer.succeed(DesignSystemFiles, files.service)),
    Layer.provide(DesignSystemProposals.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime);
  const run = <A>(
    program: (service: DesignSystemService["Service"]) => Effect.Effect<A, DesignError>,
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* program(yield* DesignSystemService);
      }),
    );
  const runEither = <A>(
    program: (service: DesignSystemService["Service"]) => Effect.Effect<A, DesignError>,
  ) =>
    runtime.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          return yield* program(yield* DesignSystemService);
        }),
      ),
    );
  return { checkout, files, previews, run, runEither, write };
}

const APP_THEME = `export const BASE_COLORS = { canvas: "#ffffff", text: "#111111", accent: "#5b6cff", border: "#dddddd", muted: "#777777" };
export const IRIS = { id: "iris", appearance: "light", colors: { ...BASE_COLORS, accent: "#6d5bd0" } } as const;
`;
const APP_CSS = `:root {
${["canvas", "text", "accent", "border", "muted"].map((key) => `  --${key}: var(--app-theme-${key});`).join("\n")}
  --radius: 8px;
}
${["canvas", "text", "accent", "border", "muted", "canvas", "text", "accent"].map((key, index) => `.x${index} { color: var(--app-theme-${key}); }`).join("\n")}
`;

describe("DesignSystemService", () => {
  it("rescans a tokens-only kit into its components and brand files, then stores the kept files", async () => {
    const { checkout, files, run } = await setup();
    const umbrella = await layOutUmbrella();
    temps.push(umbrella);
    await NodeFSP.cp(umbrella, checkout, { recursive: true });
    const put = async (path: string, text: string) => {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(checkout, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(checkout, path), text);
    };
    await put(`${UIKIT}/README.md`, "# UI kit");
    await put("repositories/acme/status-site/public/brand/mark.svg", "<svg id='mark'/>");
    await put("repositories/acme/status-site/public/brand/mark-dark.svg", "<svg id='dark'/>");

    // Imported from the tokens alone, as EasyChamp's kit was before scans grouped its barrels.
    const first = await run((service) =>
      service.propose(userCaller, {
        owner: project,
        from: { kind: "code", paths: [UIKIT_TOKENS], name: "Kit" },
      }),
    );
    const kept = await run((service) =>
      service.confirm(userCaller, {
        proposalId: first.id,
        excludeTokens: [],
        excludeComponents: [],
        excludeFiles: (first.files ?? []).map((file) => file.path),
      }),
    );
    expect(kept.system.tokens.length).toBeGreaterThan(0);
    expect(kept.system.components).toEqual([]);
    expect(kept.system.previews).toBeUndefined();
    expect([...files.storedFiles.values()].flatMap((stored) => [...stored.keys()])).toEqual([]);

    const rescan = await run((service) =>
      service.rescan(userCaller, { owner: project, systemId: kept.system.id }),
    );
    if (rescan.status !== "changed") throw new Error(`expected changed, got ${rescan.status}`);
    expect(rescan).toMatchObject({ changed: [], missing: [], added: [UIKIT_BARREL] });
    expect(
      rescan.proposal.components.map((change) => [change.component.name, change.change]),
    ).toEqual([
      ["Button", "added"],
      ["Card", "added"],
      ["Dialog", "added"],
    ]);
    expect(rescan.proposal.files?.map((file) => [file.source, file.path])).toEqual([
      [`${UIKIT}/README.md`, "README.md"],
      ["repositories/acme/status-site/public/brand/mark-dark.svg", "assets/Brand/mark-dark.svg"],
      ["repositories/acme/status-site/public/brand/mark.svg", "assets/Brand/mark.svg"],
    ]);
    expect(STATUS_COPY.startsWith("repositories/acme/status-site/public/brand/")).toBe(true);

    // A file changed after the review is not written; an unticked one is not either.
    await put("repositories/acme/status-site/public/brand/mark-dark.svg", "<svg id='edited'/>");
    const confirmed = await run((service) =>
      service.confirm(userCaller, {
        proposalId: rescan.proposal.id,
        excludeTokens: [],
        excludeComponents: [],
        excludeFiles: ["assets/Brand/mark.svg"],
      }),
    );
    expect(confirmed.system.components).toHaveLength(3);
    // Confirming builds previews from the kit's code and records where each one is.
    expect(confirmed.system.components.map((component) => component.previewFile)).toEqual([
      "previews/Button.html",
      "previews/Card.html",
      "previews/Dialog.html",
    ]);
    expect(confirmed.system.previews).toMatchObject({ rendered: 3, total: 3 });
    expect(confirmed.system.sources.map((source) => source.location)).toEqual([
      UIKIT_BARREL,
      UIKIT_TOKENS,
    ]);
    const stored = files.storedFiles.get(
      `${NodePath.join(checkout, ".specweave/design")}|${kept.system.id}`,
    );
    expect([...(stored?.keys() ?? [])]).toEqual([
      "README.md",
      "previews/Button.html",
      "previews/Card.html",
      "previews/Dialog.html",
    ]);
    expect(new TextDecoder().decode(stored!.get("README.md"))).toBe("# UI kit");

    // With components and stored files, a rescan only compares hashes again.
    const again = await run((service) =>
      service.rescan(userCaller, { owner: project, systemId: kept.system.id }),
    );
    expect(again.status).toBe("unchanged");
  });

  it("rebuilds previews for the user only, and says why when a system has nothing to render", async () => {
    const { checkout, previews, run, runEither } = await setup();
    const umbrella = await layOutUmbrella();
    temps.push(umbrella);
    await NodeFSP.cp(umbrella, checkout, { recursive: true });
    const proposal = await run((service) =>
      service.propose(userCaller, {
        owner: project,
        from: { kind: "code", paths: [UIKIT_TOKENS, UIKIT_BARREL], name: "Kit" },
      }),
    );
    const confirmed = await run((service) =>
      service.confirm(userCaller, {
        proposalId: proposal.id,
        excludeTokens: [],
        excludeComponents: [],
      }),
    );
    expect(previews.builds).toHaveLength(1);

    const refused = await runEither((service) =>
      service.rebuildPreviews(agent(project), { owner: project, systemId: confirmed.system.id }),
    );
    expect(refused.code).toBe("forbidden");
    expect(previews.builds).toHaveLength(1);

    const rebuilt = await run((service) =>
      service.rebuildPreviews(userCaller, { owner: project, systemId: confirmed.system.id }),
    );
    expect(previews.builds).toHaveLength(2);
    expect(rebuilt.problems).toEqual([]);
    expect(rebuilt.system.revision).toBe(confirmed.system.revision + 1);
    expect(confirmed.system.revision).toBe(0);
    expect(
      rebuilt.system.components.every((component) => component.previewFile !== undefined),
    ).toBe(true);

    // A failed rebuild keeps the previews that built before: nothing is deleted or forgotten.
    const storesBefore = previews.stores.length;
    previews.next.fail = true;
    const failed = await run((service) =>
      service.rebuildPreviews(userCaller, { owner: project, systemId: confirmed.system.id }),
    );
    expect(failed.problems).toEqual([
      "kit: install its dependencies to build previews.",
      "Kept the previous previews.",
    ]);
    expect(failed.system.previews).toEqual(rebuilt.system.previews);
    expect(failed.system.components.map((component) => component.previewFile)).toEqual(
      rebuilt.system.components.map((component) => component.previewFile),
    );
    expect(previews.stores).toHaveLength(storesBefore);

    const tokensOnly = await run((service) =>
      service.propose(userCaller, {
        owner: project,
        from: { kind: "code", paths: [UIKIT_TOKENS], name: "Tokens" },
      }),
    );
    const plain = await run((service) =>
      service.confirm(userCaller, {
        proposalId: tokensOnly.id,
        excludeTokens: [],
        excludeComponents: [],
      }),
    );
    const nothing = await run((service) =>
      service.rebuildPreviews(userCaller, { owner: project, systemId: plain.system.id }),
    );
    expect(nothing.problems).toEqual([
      "This system has no components from project code to preview.",
    ]);
    expect(previews.builds).toHaveLength(3);
  });

  it("offers brand files on a rescan while the system stores none (D-03)", async () => {
    const { checkout, run } = await setup();
    const umbrella = await layOutUmbrella();
    temps.push(umbrella);
    await NodeFSP.cp(umbrella, checkout, { recursive: true });
    const proposal = await run((service) =>
      service.propose(userCaller, {
        owner: project,
        from: { kind: "code", paths: [UIKIT_TOKENS, UIKIT_BARREL], name: "Kit" },
      }),
    );
    const imported = await run((service) =>
      service.confirm(userCaller, {
        proposalId: proposal.id,
        excludeTokens: [],
        excludeComponents: [],
      }),
    );
    // The README arrives after the import, so only brand files are new.
    await NodeFSP.writeFile(NodePath.join(checkout, UIKIT, "README.md"), "# UI kit");

    const rescan = await run((service) =>
      service.rescan(userCaller, { owner: project, systemId: imported.system.id }),
    );
    if (rescan.status !== "changed") throw new Error(`expected changed, got ${rescan.status}`);
    expect(rescan).toMatchObject({ changed: [], missing: [] });
    expect(rescan.proposal.files?.map((file) => file.path)).toEqual(["README.md"]);
  });

  it("scans, proposes, confirms the reviewed items, and rescans without parsing when nothing changed", async () => {
    const { files, run, write } = await setup();
    const scan = await run((service) => service.scan(userCaller, { owner: project }));
    expect(scan.suggestions.find((suggestion) => suggestion.key === "weave")?.paths).toEqual([
      "design/weave/tokens.json",
      "design/weave/weave.css",
    ]);

    const proposal = await run((service) =>
      service.propose(userCaller, {
        owner: project,
        from: { kind: "code", paths: ["design/weave/tokens.json", "design/weave/weave.css"] },
      }),
    );
    expect(proposal.system).toMatchObject({ id: "weave", name: "Weave", revision: 0 });
    expect(proposal.tokens.every((change) => change.change === "added")).toBe(true);

    const confirmed = await run((service) =>
      service.confirm(userCaller, {
        proposalId: proposal.id,
        excludeTokens: ["wv-brand-tile"],
        excludeComponents: ["css:.wv-root"],
      }),
    );
    expect(confirmed.ref.path).toBe(".specweave/design/systems/weave/system.json");
    expect(confirmed.system.tokens.map((token) => token.name)).not.toContain("wv-brand-tile");
    expect(confirmed.system.components).toHaveLength(10);
    expect(files.writes).toHaveLength(1);
    await expect(run((service) => service.getProposal(userCaller, proposal.id))).rejects.toThrow(
      /gone/,
    );

    const unchanged = await run((service) =>
      service.rescan(userCaller, { owner: project, systemId: "weave" }),
    );
    expect(unchanged.status).toBe("unchanged");

    const css = fixture("weave/weave.css.fixture");
    await write(
      "design/weave/weave.css",
      css.replace("--wv-radius-lg: 14px;", "--wv-radius-lg: 16px;"),
    );
    await write(
      "design/weave/tokens.json",
      fixture("weave/tokens.json.fixture").replace('"value": "14px"', '"value": "16px"'),
    );
    const changed = await run((service) =>
      service.rescan(userCaller, { owner: project, systemId: "weave" }),
    );
    expect(changed.status).toBe("changed");
    if (changed.status !== "changed") return;
    expect(changed.changed).toEqual(["design/weave/tokens.json", "design/weave/weave.css"]);
    expect(changed.proposal.target).toEqual({ systemId: "weave", revision: 0 });
    expect(
      changed.proposal.tokens
        .filter((change) => change.change === "changed")
        .map((change) => change.name),
    ).toEqual(["wv-radius-lg"]);
    // The token excluded last time comes back as new; nothing else moved.
    expect(
      changed.proposal.tokens
        .filter((change) => change.change === "added")
        .map((change) => change.name),
    ).toEqual(["wv-brand-tile"]);
  });

  it("previews the top three suggestions in memory when asked; without it the shape is unchanged", async () => {
    const { checkout, files, run, write } = await setup();
    for (const app of ["a", "b", "c"]) {
      await write(`apps/${app}/package.json`, JSON.stringify({ name: `app-${app}` }));
      await write(
        `apps/${app}/${app}.css`,
        `:root {\n${Array.from({ length: 10 }, (_, index) => `  --${app}-${index}: #00000${index};`).join("\n")}\n}`,
      );
    }
    const plain = await run((service) => service.scan(userCaller, { owner: project }));
    expect(plain.suggestions.filter((suggestion) => "preview" in suggestion)).toEqual([]);

    const scan = await run((service) =>
      service.scan(userCaller, { owner: project, preview: true }),
    );
    expect(scan.suggestions.map((suggestion) => [suggestion.key, "preview" in suggestion])).toEqual(
      [
        ["weave", true],
        ["pkg:apps/a", true],
        ["pkg:apps/b", true],
        ["pkg:apps/c", false],
      ],
    );
    expect(scan.suggestions[1]!.preview).toMatchObject({
      tokens: 10,
      components: 0,
      modes: ["default"],
      sources: [{ path: "apps/a/a.css", kind: "css", tokens: 10, components: 0 }],
    });
    expect(scan.suggestions[1]!.preview!.swatches.map((swatch) => swatch.value)).toEqual(
      Array.from({ length: 8 }, (_, index) => `#00000${index}`),
    );
    // A preview keeps no proposal and writes nothing.
    expect(
      (await run((service) => service.proposals(userCaller, { kind: "all" }))).proposals,
    ).toEqual([]);
    expect(files.writes).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(checkout, ".specweave"))).toBe(false);

    // It counts what a proposal from the same files holds.
    const weave = scan.suggestions[0]!;
    const proposal = await run((service) =>
      service.propose(userCaller, { owner: project, from: { kind: "code", paths: weave.paths } }),
    );
    expect(weave.preview).toMatchObject({
      tokens: proposal.system.tokens.length,
      components: proposal.system.components.length,
    });
    expect(weave.preview!.swatches.length).toBeGreaterThan(0);
  });

  it("links the app theme to Weave only when this owner holds Weave, and never writes a dangling link", async () => {
    const { checkout, files, run, write } = await setup();
    await write("packages/shared/src/themePalettes.ts", APP_THEME);
    await write("apps/web/src/index.css", APP_CSS);
    const appTheme = ["apps/web/src/index.css", "packages/shared/src/themePalettes.ts"];
    const themeSuggestion = async () =>
      (await run((service) => service.scan(userCaller, { owner: project }))).suggestions.find(
        (suggestion) => suggestion.key === "specwithcode-app-theme",
      )!;

    // No Weave in this project yet: a label, no reference.
    const before = await themeSuggestion();
    expect(before.derivedFromLabel).toBe("Weave");
    expect(before).not.toHaveProperty("derivedFrom");
    const unlinked = await run((service) =>
      service.propose(userCaller, { owner: project, from: { kind: "code", paths: appTheme } }),
    );
    expect(unlinked.system.derivedFromLabel).toBe("Weave");
    expect(unlinked.system).not.toHaveProperty("derivedFrom");

    // Weave held by another owner (the Playground) does not count.
    files.systems.set(`${NodePath.join(checkout, "playground")}|weave`, {
      ...(unlinked.system as DesignSystem),
      id: "weave" as never,
      name: "Weave",
    });
    expect(await themeSuggestion()).not.toHaveProperty("derivedFrom");

    // Weave confirmed in this project: a real reference to it.
    const weave = await run((service) =>
      service.propose(userCaller, {
        owner: project,
        from: { kind: "code", paths: ["design/weave/tokens.json", "design/weave/weave.css"] },
      }),
    );
    await run((service) =>
      service.confirm(userCaller, {
        proposalId: weave.id,
        excludeTokens: [],
        excludeComponents: [],
      }),
    );
    const lineage = {
      owner: { kind: "project", environmentId: "env", projectId: PROJECT },
      systemId: "weave",
    };
    expect((await themeSuggestion()).derivedFrom).toEqual(lineage);
    const linked = await run((service) =>
      service.propose(userCaller, { owner: project, from: { kind: "code", paths: appTheme } }),
    );
    expect(linked.system.derivedFrom).toEqual(lineage);

    // Weave goes before the user confirms: the written system keeps only the label.
    // Keys hold native paths, so Windows separates them with backslashes.
    const weaveKey = [...files.systems.keys()].find((key) =>
      key.replaceAll("\\", "/").endsWith(".specweave/design|weave"),
    );
    expect(weaveKey).toBeDefined();
    files.systems.delete(weaveKey!);
    const written = await run((service) =>
      service.confirm(userCaller, {
        proposalId: linked.id,
        excludeTokens: [],
        excludeComponents: [],
      }),
    );
    expect(written.system).not.toHaveProperty("derivedFrom");
    expect(written.system.derivedFromLabel).toBe("Weave");
  });

  it("lets an agent propose but never confirm, and only inside its own project", async () => {
    const { run, runEither } = await setup();
    const described = await run((service) =>
      service.proposeDescribed(agent(project), project, {
        name: "Calm",
        modes: ["light", "dark"],
        tokens: [
          { name: "--ink", type: "color", value: { light: "#111", dark: "#eee" } },
          { name: "space-2", value: "8px" },
        ],
      }),
    );
    expect(described.origin).toBe("agent");
    expect(
      described.system.tokens.find((token) => token.name === "ink")!.values.dark!.provenance,
    ).toMatchObject({
      source: "agent",
      location: "thread:thread-1",
    });
    expect(described.system.tokens.find((token) => token.name === "space-2")!.type).toBe(
      "dimension",
    );

    const refused = await runEither((service) =>
      service.confirm(agent(project), {
        proposalId: described.id,
        excludeTokens: [],
        excludeComponents: [],
      }),
    );
    expect(refused.code).toBe("forbidden");
    const otherProject = await runEither((service) =>
      service.scan(agent(project), { owner: { kind: "project", projectId: OTHER } }),
    );
    expect(otherProject.code).toBe("forbidden");
    const hidden = await runEither((service) =>
      service.getProposal(agent({ kind: "project", projectId: OTHER }), described.id),
    );
    expect(hidden.code).toBe("not_found");

    const list = await run((service) => service.proposals(userCaller, { kind: "all" }));
    expect(list.proposals.map((summary) => [summary.name, summary.counts.added])).toEqual([
      ["Calm", 2],
    ]);
    const confirmed = await run((service) =>
      service.confirm(userCaller, {
        proposalId: described.id,
        excludeTokens: [],
        excludeComponents: [],
        name: "Calm system",
      }),
    );
    expect(confirmed.system).toMatchObject({ id: "calm", name: "Calm system" });
  });

  it("imports a Figma export into the Playground and refuses a code scan there", async () => {
    const { run, runEither } = await setup();
    const proposal = await run((service) =>
      service.propose(userCaller, {
        owner: { kind: "playground" },
        from: {
          kind: "tokens-file",
          files: [
            {
              fileName: "Brand.Light.tokens.json",
              contents: '{"brand": {"$type": "color", "$value": "#5b6cff"}}',
            },
          ],
          name: "Brand",
        },
      }),
    );
    expect(proposal.system.sources).toEqual([
      {
        kind: "figma-export",
        location: "Brand.Light.tokens.json",
        sha256: expect.any(String),
        readAt: "2026-10-20T12:00:00.000Z",
      },
    ]);
    const scan = await runEither((service) =>
      service.scan(userCaller, { owner: { kind: "playground" } }),
    );
    expect(scan.code).toBe("invalid");
    const rescan = await run((service) =>
      Effect.gen(function* () {
        yield* service.confirm(userCaller, {
          proposalId: proposal.id,
          excludeTokens: [],
          excludeComponents: [],
        });
        return yield* service.rescan(userCaller, {
          owner: { kind: "playground" },
          systemId: "brand",
        });
      }),
    );
    expect(rescan.status).toBe("not-rescannable");
  });

  it("reports Figma desktop as off with how to turn it on", async () => {
    const { run, runEither } = await setup();
    expect((await run((service) => service.figmaStatus())).state).toBe("off");
    const failure = await runEither((service) =>
      service.propose(userCaller, { owner: project, from: { kind: "figma-desktop" } }),
    );
    expect(failure.detail).toContain("Enable desktop MCP server");
  });

  it("checks an agent's scope itself, even when the roots would allow the owner", async () => {
    const { runEither } = await setup({ permissiveRoots: true });
    const other = { kind: "project" as const, projectId: OTHER };
    const attempts: ReadonlyArray<
      (service: DesignSystemService["Service"]) => Effect.Effect<unknown, DesignError>
    > = [
      (service: DesignSystemService["Service"]) => service.scan(agent(project), { owner: other }),
      (service: DesignSystemService["Service"]) =>
        service.propose(agent(project), {
          owner: other,
          from: { kind: "code", paths: ["design/weave/weave.css"] },
        }),
      (service: DesignSystemService["Service"]) =>
        service.proposeDescribed(agent(project), other, {
          name: "X",
          tokens: [{ name: "a", value: "1px" }],
        }),
      (service: DesignSystemService["Service"]) =>
        service.rescan(agent(project), { owner: other, systemId: "weave" }),
    ];
    for (const attempt of attempts) {
      expect((await runEither(attempt)).code).toBe("forbidden");
    }
  });

  it("caps proposals per actor without evicting the user's pending reviews", async () => {
    const { run } = await setup();
    const mine = await run((service) =>
      service.proposeDescribed(userCaller, project, {
        name: "Mine",
        tokens: [{ name: "a", value: "1px" }],
      }),
    );
    const agentIds: string[] = [];
    for (let index = 0; index < MAX_PROPOSALS_PER_ACTOR + 5; index += 1) {
      const proposal = await run((service) =>
        service.proposeDescribed(agent(project), project, {
          name: `Agent ${index}`,
          tokens: [{ name: "a", value: `${index}px` }],
        }),
      );
      agentIds.push(proposal.id);
    }
    const open = await run((service) => service.proposals(userCaller, { kind: "all" }));
    const ids = open.proposals.map((proposal) => proposal.id);
    expect(ids).toContain(mine.id);
    // The agent keeps only its newest proposals; its oldest went first.
    expect(ids.filter((id) => agentIds.includes(id))).toHaveLength(MAX_PROPOSALS_PER_ACTOR);
    expect(ids).not.toContain(agentIds[0]);
    expect(ids).toContain(agentIds.at(-1));
  });

  it("replaces an open proposal for the same files instead of adding another", async () => {
    const { run } = await setup();
    const both = {
      kind: "code" as const,
      paths: ["design/weave/tokens.json", "design/weave/weave.css"],
    };
    const first = await run((service) =>
      service.propose(userCaller, { owner: project, from: both }),
    );
    const again = await run((service) =>
      service.propose(userCaller, {
        owner: project,
        from: { ...both, paths: both.paths.toReversed() },
      }),
    );
    // Same id and system id: a design that recorded the first proposal still points at it.
    expect(again).toMatchObject({ id: first.id, system: { id: first.system.id } });
    const fewer = await run((service) =>
      service.propose(userCaller, {
        owner: project,
        from: { kind: "code", paths: ["design/weave/weave.css"] },
      }),
    );
    expect(fewer.id).not.toBe(first.id);
    const open = await run((service) => service.proposals(userCaller, { kind: "all" }));
    expect(open.proposals.map((proposal) => proposal.id).toSorted()).toEqual(
      [first.id, fewer.id].toSorted(),
    );
  });

  it("keeps described proposals apart even when they share a name and location", async () => {
    const { run } = await setup();
    const colors = await run((service) =>
      service.proposeDescribed(agent(project), project, {
        name: "Brand",
        tokens: [{ name: "brand", value: "#0a84ff" }],
      }),
    );
    const type = await run((service) =>
      service.proposeDescribed(agent(project), project, {
        name: "Brand",
        tokens: [{ name: "body", value: "16px" }],
      }),
    );
    expect(type.id).not.toBe(colors.id);
    const open = await run((service) => service.proposals(userCaller, { kind: "all" }));
    expect(open.proposals.map((proposal) => proposal.id)).toEqual(
      expect.arrayContaining([colors.id, type.id]),
    );
  });
});
