// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - A child process and plain files inside one approved root.
/**
 * Live previews for a code-imported design system, the way Claude Design shows
 * a kit: each component's stories rendered to static HTML, plus one stylesheet
 * with the kit's CSS, fonts and images inlined. The kit's own code runs only in
 * a child Node process started inside the kit's package (its esbuild, React and
 * Storybook), never in the server, and only when a person confirms an import or
 * asks for a rebuild.
 *
 * The result is a set of stored files (`previews/<group>/<Component>.html`, one
 * `<section data-swc-story>` per story, and `previews/preview.css`) and, for each
 * component, which file holds its preview or why it has none.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DESIGN_PREVIEW_STORY_ATTRIBUTE,
  DESIGN_SYSTEM_FILE_MAX_BYTES,
  type DesignSystem,
  type DesignSystemPreviews,
} from "@specweave-studio/contracts";

import { storedFileName } from "../brandFiles.ts";
import { compareText } from "../common.ts";
import { listFolders } from "../proposal.ts";
import { isExcludedPath } from "../scanCandidates.ts";
import {
  deleteSystemFile,
  listSystemFiles,
  pathProblem,
  putSystemFile,
} from "../SystemFilesStore.ts";
import { PREVIEW_RUNNER_SOURCE } from "./runnerSource.ts";

/** Where built previews are stored, beside the system's other files. */
export const PREVIEWS_FOLDER = "previews";
export const PREVIEW_STYLESHEET = `${PREVIEWS_FOLDER}/preview.css`;
/** One build may take this long before its process is stopped. */
export const PREVIEW_BUILD_TIMEOUT_MS = 180_000;
const NOTE_MAX = 500;

const STORY_FILE = /\.stories\.(?:tsx|ts|jsx|js|mjs)$/;
const PREVIEW_FILES = ["preview.tsx", "preview.ts", "preview.jsx", "preview.js", "preview.mjs"];
const SVG_CHILD = /^\s*<(?:g|path|rect|circle|ellipse|line|polyline|polygon|text|defs|use)\b/i;

export interface PreviewFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface PreviewBuild {
  /** Files to store, replacing any earlier build's files under `previews/`. */
  readonly files: ReadonlyArray<PreviewFile>;
  /** Per component id: the stored preview file, or why there is none. */
  readonly components: ReadonlyMap<
    string,
    { readonly previewFile?: string; readonly previewNote?: string }
  >;
  /** False when some package's build failed, so its earlier previews are worth keeping. */
  readonly complete: boolean;
  /** Null when nothing rendered at all (no package, no dependencies, a failed build). */
  readonly previews: DesignSystemPreviews | null;
  /** What a person should know about the build as a whole, in plain words. */
  readonly problems: ReadonlyArray<string>;
}

export interface PreviewBuildOptions {
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** The Node binary for the child; the server's own by default (Electron runs it as Node). */
  readonly execPath?: string;
}

interface RunnerResult {
  readonly fatal: "esbuild" | "react" | "bundle" | null;
  readonly problems: ReadonlyArray<string>;
  readonly components: Record<
    string,
    {
      readonly stories: ReadonlyArray<{ readonly name: string; readonly html: string }>;
      readonly note: string | null;
      readonly notComponent?: boolean;
    }
  >;
  readonly css: string;
  readonly cssSkipped: ReadonlyArray<string>;
}

const FATAL_NOTES: Record<NonNullable<RunnerResult["fatal"]>, string> = {
  esbuild:
    "Previews need the kit's dependencies installed (esbuild, through Vite, tsup or directly). Install them, then rebuild.",
  react:
    "Previews need React and react-dom installed in the kit. Install its dependencies, then rebuild.",
  bundle: "The kit's code did not bundle for previews",
};

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const clipNote = (note: string) =>
  note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX - 1)}…` : note;
const escapeAttribute = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const exists = (path: string) =>
  NodeFSP.stat(path).then(
    () => true,
    () => false,
  );

/** The nearest folder at or above `file`'s folder, inside the root, that holds a package.json. */
const packageRootOf = async (realRoot: string, file: string): Promise<string | null> => {
  let folder = folderOf(file);
  for (;;) {
    if (await exists(NodePath.join(realRoot, folder, "package.json"))) return folder;
    if (folder === "") return null;
    folder = folderOf(folder);
  }
};

/** The CSS a package publishes: `style`, and `exports` entries that are stylesheets. */
const publishedCss = async (realRoot: string, packageRoot: string): Promise<string[]> => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(realRoot, packageRoot, "package.json"), "utf8"),
    );
  } catch {
    return [];
  }
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (value.endsWith(".css") && !value.includes("*")) found.add(value.replace(/^\.\//, ""));
    } else if (value !== null && typeof value === "object") {
      for (const inner of Object.values(value)) visit(inner);
    }
  };
  if (manifest !== null && typeof manifest === "object") {
    visit((manifest as { style?: unknown }).style);
    visit((manifest as { exports?: unknown }).exports);
  }
  const present: string[] = [];
  for (const file of [...found].sort(compareText)) {
    if (file.split("/").includes("..")) continue;
    if (await exists(NodePath.join(realRoot, packageRoot, file))) present.push(file);
  }
  return present;
};

/** Windows has no process groups; a POSIX child leads its own, so a kill reaches its children. */
// oxlint-disable-next-line studio/no-global-process-runtime -- the build is plain async I/O outside any Effect runtime.
const POSIX = process.platform !== "win32";
const CHILD_ENV = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "LANG", "USERPROFILE"];

const runChild = (
  execPath: string,
  args: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly stderr: string; readonly timedOut: boolean }> =>
  new Promise((resolve) => {
    const child = NodeChildProcess.spawn(execPath, [...args], {
      cwd,
      // Kit code runs here, so it sees only what a build needs, never the server's secrets.
      env: {
        ...Object.fromEntries(
          CHILD_ENV.flatMap((name) =>
            process.env[name] === undefined ? [] : [[name, process.env[name]]],
          ),
        ),
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "ignore", "pipe"],
      // Its own process group, so a timeout stops anything it started too.
      detached: POSIX,
    });
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (POSIX && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    });
  });

/** A preview file's name: its group folder and export name, as stored names allow. */
const previewPathFor = (
  component: DesignSystem["components"][number],
  taken: Set<string>,
): string | null => {
  const group = component.group ? storedFileName(`${component.group}.x`)?.slice(0, -2) : undefined;
  const name = storedFileName(`${component.exportName ?? component.name}.html`);
  if (name === null) return null;
  const base = group ? `${PREVIEWS_FOLDER}/${group}/${name}` : `${PREVIEWS_FOLDER}/${name}`;
  let path = base;
  for (let count = 2; taken.has(path.toLowerCase()); count += 1) {
    path = base.replace(/\.html$/, ` ${count}.html`);
  }
  if (pathProblem(path) !== null) return null;
  taken.add(path.toLowerCase());
  return path;
};

/** One story as a section; an SVG fragment (a `<g>` or shape) gets an `<svg>` around it. */
const storySection = (story: { readonly name: string; readonly html: string }) => {
  const body = SVG_CHILD.test(story.html)
    ? `<svg xmlns="http://www.w3.org/2000/svg" data-swc-fragment="">${story.html}</svg>`
    : story.html;
  return `<section ${DESIGN_PREVIEW_STORY_ATTRIBUTE}="${escapeAttribute(story.name)}">${body}</section>`;
};

/**
 * Builds previews for the system's file-sourced components. Never throws: what
 * cannot be built is reported in `problems` and in each component's note.
 */
export const buildPreviews = async (
  realRoot: string,
  system: DesignSystem,
  options: PreviewBuildOptions = {},
): Promise<PreviewBuild> => {
  const components = new Map<string, { previewFile?: string; previewNote?: string }>();
  const problems: string[] = [];
  // Components in packages that did not build: counted in the total, never rendered.
  let failed = 0;
  const empty = (problem?: string): PreviewBuild => {
    if (problem !== undefined) problems.push(problem);
    return { files: [], components, previews: null, problems, complete: failed === 0 };
  };

  // Components by the package that holds their file.
  const packages = new Map<
    string,
    Array<{ id: string; file: string; exportName: string; props: unknown }>
  >();
  for (const component of system.components) {
    const location = component.provenance.source === "file" ? component.provenance.location : null;
    if (location === null || component.exportName === undefined || isExcludedPath(location)) {
      components.set(component.id, {
        previewNote: "It was not imported from a code file, so there is nothing to render.",
      });
      continue;
    }
    const root = await packageRootOf(realRoot, location);
    if (root === null) {
      components.set(component.id, { previewNote: "No package.json holds its file." });
      continue;
    }
    const list = packages.get(root) ?? [];
    list.push({
      id: component.id,
      file: root === "" ? location : location.slice(root.length + 1),
      exportName: component.exportName,
      props: component.props ?? [],
    });
    packages.set(root, list);
  }
  if (packages.size === 0) return empty();

  const results: Array<{ root: string; result: RunnerResult }> = [];
  for (const [root, list] of [...packages].sort((left, right) => compareText(left[0], right[0]))) {
    const packageFolder = NodePath.join(realRoot, root);
    if (!(await exists(NodePath.join(packageFolder, "node_modules")))) {
      for (const component of list) {
        components.set(component.id, {
          previewNote:
            "Its package's dependencies are not installed. Install them, then rebuild previews.",
        });
      }
      problems.push(`${root || "The project"}: install its dependencies to build previews.`);
      failed += list.length;
      continue;
    }
    const folders = await listFolders(realRoot, root).catch(() => new Map<string, string[]>());
    const storyFiles = [...folders.values()]
      .flat()
      .filter((file) => STORY_FILE.test(file))
      .map((file) => (root === "" ? file : file.slice(root.length + 1)))
      .sort(compareText);
    let previewFile: string | null = null;
    for (const name of PREVIEW_FILES) {
      if (await exists(NodePath.join(packageFolder, ".storybook", name))) {
        previewFile = `.storybook/${name}`;
        break;
      }
    }
    const cacheRoot = NodePath.join(
      packageFolder,
      "node_modules",
      ".cache",
      "specwithcode-previews",
    );
    await NodeFSP.mkdir(cacheRoot, { recursive: true });
    // A folder per run, so two builds of one package never share a job, bundle or result.
    const cacheDir = await NodeFSP.mkdtemp(NodePath.join(cacheRoot, "run-"));
    const runner = NodePath.join(cacheDir, "runner.mjs");
    const jobPath = NodePath.join(cacheDir, "job.json");
    const resultPath = NodePath.join(cacheDir, "result.json");
    await NodeFSP.writeFile(runner, PREVIEW_RUNNER_SOURCE);
    await NodeFSP.writeFile(
      jobPath,
      JSON.stringify({
        packageRoot: packageFolder,
        cacheDir,
        resultPath,
        storyFiles,
        previewFile,
        cssFiles: await publishedCss(realRoot, root),
        components: list,
      }),
    );
    const run = await runChild(
      options.execPath ?? process.execPath,
      [runner, jobPath],
      packageFolder,
      options.timeoutMs ?? PREVIEW_BUILD_TIMEOUT_MS,
    );
    let result: RunnerResult | null = null;
    try {
      result = JSON.parse(await NodeFSP.readFile(resultPath, "utf8")) as RunnerResult;
    } catch {
      result = null;
    }
    await NodeFSP.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    if (result === null) {
      const why = run.timedOut
        ? `it ran past ${Math.round((options.timeoutMs ?? PREVIEW_BUILD_TIMEOUT_MS) / 1000)} seconds`
        : (run.stderr.trim().split("\n").at(-1) ?? `it exited with code ${run.code}`);
      problems.push(`${root || "The project"}: previews did not build, ${why}`.slice(0, NOTE_MAX));
      for (const component of list) {
        components.set(component.id, {
          previewNote: "Previews did not build for its package. Rebuild to try again.",
        });
      }
      failed += list.length;
      continue;
    }
    if (result.fatal !== null) {
      const note =
        FATAL_NOTES[result.fatal] + (result.problems[0] ? `: ${result.problems[0]}` : "");
      problems.push(`${root || "The project"}: ${note}`.slice(0, NOTE_MAX));
      for (const component of list) components.set(component.id, { previewNote: clipNote(note) });
      failed += list.length;
      continue;
    }
    problems.push(...result.problems.slice(0, 5).map((problem) => clipNote(`${root}: ${problem}`)));
    results.push({ root, result });
  }

  // Files, in the system's component order so names are stable from build to build.
  const files: PreviewFile[] = [];
  const taken = new Set<string>();
  const encoder = new TextEncoder();
  let rendered = 0;
  let total = failed;
  const byId = new Map<string, RunnerResult["components"][string]>();
  for (const { result } of results) {
    for (const [id, entry] of Object.entries(result.components)) byId.set(id, entry);
  }
  for (const component of system.components) {
    const entry = byId.get(component.id);
    if (entry === undefined) continue;
    if (entry.notComponent !== true) total += 1;
    if (entry.stories.length === 0) {
      components.set(component.id, {
        previewNote: clipNote(
          entry.note ?? "No story rendered it. Add a story with example props.",
        ),
      });
      continue;
    }
    const path = previewPathFor(component, taken);
    const html = entry.stories.map(storySection).join("\n");
    const bytes = encoder.encode(html);
    if (path === null || bytes.byteLength > DESIGN_SYSTEM_FILE_MAX_BYTES) {
      components.set(component.id, {
        previewNote: "Its rendered stories are too large to store. Trim its stories, then rebuild.",
      });
      continue;
    }
    files.push({ path, bytes });
    components.set(component.id, { previewFile: path });
    rendered += 1;
  }
  if (results.length === 0) return empty();

  const css = encoder.encode(results.map(({ result }) => result.css).join("\n"));
  if (css.byteLength === 0) {
    problems.push("The kit ships no built stylesheet, so previews show without its styles.");
  }
  if (css.byteLength > DESIGN_SYSTEM_FILE_MAX_BYTES) {
    problems.push("The kit's stylesheet is over 10 MiB, so previews show without it.");
  } else {
    files.push({ path: PREVIEW_STYLESHEET, bytes: css });
  }
  return {
    files,
    components,
    previews: {
      stylesheetFile: PREVIEW_STYLESHEET,
      builtAt: (options.now?.() ?? new Date()).toISOString(),
      rendered,
      total,
      ...(problems.length === 0 ? {} : { problems: problems.slice(0, 20).map(clipNote) }),
    },
    problems,
    complete: failed === 0,
  };
};

/** Builds and stores previews; a seam so tests never start a child process. */
export interface PreviewBuilder {
  readonly build: (realRoot: string, system: DesignSystem) => Promise<PreviewBuild>;
  /** Replaces the stored `previews/` folder with `files`: earlier files not rebuilt are removed. */
  readonly store: (
    designRoot: string,
    systemId: string,
    files: ReadonlyArray<PreviewFile>,
  ) => Promise<void>;
}

export const nodePreviewBuilder: PreviewBuilder = {
  build: (realRoot, system) => buildPreviews(realRoot, system),
  store: async (designRoot, systemId, files) => {
    const keep = new Set(files.map((file) => file.path));
    const { files: stored } = await listSystemFiles(designRoot, systemId);
    for (const file of stored) {
      if (file.path.startsWith(`${PREVIEWS_FOLDER}/`) && !keep.has(file.path)) {
        await deleteSystemFile(designRoot, systemId, file.path);
      }
    }
    for (const file of files) await putSystemFile(designRoot, systemId, file.path, file.bytes);
  },
};
