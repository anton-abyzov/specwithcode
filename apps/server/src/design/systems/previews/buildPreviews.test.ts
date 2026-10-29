// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DesignSystem } from "@specweave-studio/contracts";
import { newDesignSystem } from "@specweave-studio/shared/designSystemOps";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveDesignRoot, writeDesignSystem } from "../../DesignStore.ts";
import { listSystemFiles, putSystemFile, readSystemFile } from "../SystemFilesStore.ts";
import { PREVIEW_STYLESHEET, buildPreviews, nodePreviewBuilder } from "./buildPreviews.ts";
import { previewTestPackageRoot } from "./previewTestPaths.ts";

// The fixture kit borrows React and esbuild from the web app's install, as a kit has its own.
const fromWeb = NodeModule.createRequire(
  NodePath.resolve(import.meta.dirname, "../../../../../web/package.json"),
);
const packageDir = (resolve: () => string, name: string) => {
  try {
    return previewTestPackageRoot(resolve(), name);
  } catch {
    return null;
  }
};
const DEPENDENCIES = {
  react: packageDir(() => fromWeb.resolve("react"), "react"),
  "react-dom": packageDir(() => fromWeb.resolve("react-dom/server"), "react-dom"),
  esbuild: packageDir(
    () => NodeModule.createRequire(fromWeb.resolve("vite/package.json")).resolve("esbuild"),
    "esbuild",
  ),
};
const installed = Object.values(DEPENDENCIES).every((dir) => dir !== null);

const temps: string[] = [];
afterEach(async () => {
  for (const path of temps.splice(0)) await NodeFSP.rm(path, { recursive: true, force: true });
});

const checkout = async (files: Record<string, string>, withModules = true) => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "design-previews-")),
  );
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), text);
  }
  if (withModules) {
    for (const [name, dir] of Object.entries(DEPENDENCIES)) {
      await NodeFSP.mkdir(NodePath.join(root, "kit/node_modules"), { recursive: true });
      await NodeFSP.symlink(
        dir!,
        NodePath.join(root, "kit/node_modules", name),
        NodePath.sep === "\\" ? "junction" : "dir",
      );
    }
  }
  return root;
};

const KIT = {
  "kit/package.json": JSON.stringify({
    name: "kit",
    exports: { ".": "./src/index.ts", "./style.css": "./dist/style.css" },
  }),
  "kit/dist/style.css":
    ".kit-badge{color:rgb(1,2,3)}.kit-unused{color:red}:root{--kit-ink:#111}[data-theme=dark] .kit-badge{color:white}.dark .kit-badge{color:gray}",
  "kit/src/Badge.tsx":
    'export function Badge({ label, count }: { label: string; count: number }) { return <span className="kit-badge">{label} {count}</span>; }',
  "kit/src/Needy.tsx":
    "export function Needy({ team }: { team: { name: string } }) { return <b>{team.name}</b>; }",
  "kit/src/Clock.ts": "export class Clock { tick() {} }",
  "kit/src/Mark.tsx": 'export const Mark = () => <g><circle r="2" /></g>;',
};

const component = (
  name: string,
  file: string,
  props: ReadonlyArray<{ name: string; type: string; optional: boolean }> = [],
) => ({
  id: `react:kit#${name}`,
  name,
  framework: "react" as const,
  group: "core",
  importPath: "kit",
  exportName: name,
  props: [...props],
  provenance: { source: "file" as const, location: file, extractor: "components@1" },
});

const system = (): DesignSystem =>
  ({
    ...newDesignSystem({ id: "s_kit", name: "Kit", now: "2026-10-26T10:00:00.000Z" }),
    components: [
      component("Badge", "kit/src/Badge.tsx", [
        { name: "label", type: "string", optional: false },
        { name: "count", type: "number", optional: false },
      ]),
      component("Needy", "kit/src/Needy.tsx", [{ name: "team", type: "Team", optional: false }]),
      component("Clock", "kit/src/Clock.ts"),
      component("Mark", "kit/src/Mark.tsx"),
    ],
    sources: [
      {
        kind: "file",
        location: "kit/src/index.ts",
        sha256: "0".repeat(64),
        readAt: "2026-10-26T10:00:00.000Z",
      },
    ],
  }) as DesignSystem;

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe.skipIf(!installed)("buildPreviews", () => {
  it("renders components in a child process and stores one file each, with the kit's used CSS", async () => {
    const root = await checkout(KIT);
    const build = await buildPreviews(root, system(), {
      now: () => new Date("2026-10-26T12:00:00Z"),
    });

    expect(build.problems).toEqual([]);
    expect(build.previews).toEqual({
      stylesheetFile: PREVIEW_STYLESHEET,
      builtAt: "2026-10-26T12:00:00.000Z",
      rendered: 2,
      total: 3,
    });
    expect(build.complete).toBe(true);
    const badge = build.files.find((file) => file.path === "previews/core/Badge.html");
    expect(text(badge!.bytes)).toBe(
      '<section data-swc-story="Sample props"><span class="kit-badge">Label 3</span></section>',
    );
    // An SVG fragment is wrapped so it draws on its own.
    const mark = build.files.find((file) => file.path === "previews/core/Mark.html");
    expect(text(mark!.bytes)).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" data-swc-fragment=""><g>',
    );
    const css = text(build.files.find((file) => file.path === PREVIEW_STYLESHEET)!.bytes);
    expect(css).toContain(".kit-badge");
    expect(css).toContain("--kit-ink");
    expect(css).toContain("[data-theme=dark] .kit-badge");
    // The frame's theme class is kept, so class-themed kits still go dark.
    expect(css).toContain(".dark .kit-badge");
    expect(css).not.toContain("kit-unused");

    expect(build.components.get("react:kit#Badge")).toEqual({
      previewFile: "previews/core/Badge.html",
    });
    expect(build.components.get("react:kit#Needy")).toEqual({
      previewNote: "It needs props to render. Add a story with example props.",
    });
    expect(build.components.get("react:kit#Clock")).toEqual({
      previewNote: "It is not a component.",
    });
  }, 60_000);

  it("explains instead of building when the kit's dependencies are not installed", async () => {
    const root = await checkout(KIT, false);
    const build = await buildPreviews(root, system());

    expect(build.previews).toBeNull();
    expect(build.files).toEqual([]);
    expect(build.problems).toEqual(["kit: install its dependencies to build previews."]);
    expect(build.complete).toBe(false);
    expect(build.components.get("react:kit#Badge")?.previewNote).toMatch(/not installed/);
  });

  it("stops a build that runs too long", async () => {
    const root = await checkout({
      ...KIT,
      "kit/src/Badge.tsx": "while (true) {}\nexport const Badge = () => null;",
    });
    const build = await buildPreviews(root, system(), { timeoutMs: 1_500 });

    expect(build.previews).toBeNull();
    expect(build.problems[0]).toMatch(/kit: previews did not build, it ran past 2 seconds/);
  }, 30_000);
});

describe("nodePreviewBuilder.store", () => {
  it("replaces an earlier build's previews and leaves other stored files alone", async () => {
    const dir = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "design-previews-store-")),
    );
    temps.push(dir);
    const root = (await resolveDesignRoot(dir, ".specweave/design", { create: true }))!;
    await writeDesignSystem(
      root,
      newDesignSystem({ id: "s_kit", name: "Kit", now: "2026-10-26T10:00:00.000Z" }),
      {
        expectedRevision: null,
        actor: { kind: "user" },
      },
    );
    const bytes = (value: string) => new TextEncoder().encode(value);
    await putSystemFile(root, "s_kit", "README.md", bytes("# Kit"));
    await putSystemFile(root, "s_kit", "previews/core/Gone.html", bytes("old"));
    await putSystemFile(root, "s_kit", "previews/core/Badge.html", bytes("old"));

    await nodePreviewBuilder.store(root, "s_kit", [
      { path: "previews/core/Badge.html", bytes: bytes("new") },
      { path: PREVIEW_STYLESHEET, bytes: bytes(".a{}") },
    ]);

    const { files } = await listSystemFiles(root, "s_kit");
    expect(files.map((file) => file.path).sort()).toEqual([
      "README.md",
      "previews/core/Badge.html",
      "previews/preview.css",
    ]);
    expect(text((await readSystemFile(root, "s_kit", "previews/core/Badge.html")).bytes)).toBe(
      "new",
    );
  });
});
