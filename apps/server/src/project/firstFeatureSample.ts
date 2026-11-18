/**
 * The first feature guide's sample project (1398): what it holds, what it is
 * called, which project is "the sample" on this machine, the guide's two
 * stored facts, and its own automatic review switch.
 *
 * The files and rules here are plain data and functions; ManagedProjectFolders
 * makes the repository, ProjectService keeps the record, and the
 * `projects.firstFeatureGuide` handler records the guide's marks.
 *
 * @module firstFeatureSample
 */
import {
  CommandId,
  FIRST_FEATURE_SAMPLE,
  type FirstFeatureGuide,
  type FirstFeatureGuideEnd,
  type Project,
  type ProjectFirstFeatureGuideMark,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import type * as ProjectService from "./ProjectService.ts";

/** The sample's name; a taken one is numbered: "First feature 2", "First feature 3", ... */
export const FIRST_FEATURE_SAMPLE_NAME = "First feature";
const MAX_SAMPLE_NAMES = 100;

export interface SampleFile {
  /** Relative to the project folder, with forward slashes. */
  readonly path: string;
  readonly contents: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The sample's starter files (AC-01): one page, its stylesheet, a
 * `package.json` whose `test` script is `node --test`, one passing test and a
 * README. `npm test` (and so `specweave verify`) passes on a fresh copy, with
 * nothing to install.
 */
export function firstFeatureSampleFiles(name: string): ReadonlyArray<SampleFile> {
  const title = escapeHtml(name);
  return [
    {
      path: "README.md",
      contents: [
        `<img src="assets/icon.svg" width="64" height="64" alt="">`,
        "",
        `# ${name}`,
        "",
        "A sample project for a first feature in [SpecWithCode](https://specwithcode.com): one page (`index.html` and `style.css`) and one test.",
        "",
        "Run the test with `npm test`. It needs Node.js and nothing else.",
        "",
      ].join("\n"),
    },
    {
      path: "index.html",
      contents: [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8">',
        '    <meta name="viewport" content="width=device-width, initial-scale=1">',
        `    <title>${title}</title>`,
        '    <link rel="stylesheet" href="style.css">',
        "  </head>",
        "  <body>",
        "    <main>",
        `      <h1>${title}</h1>`,
        "      <p>A small page to build a first feature on.</p>",
        "    </main>",
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    },
    {
      path: "style.css",
      contents: [
        "body {",
        "  margin: 0;",
        "  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;",
        "  background: #ffffff;",
        "  color: #1f2937;",
        "}",
        "",
        "main {",
        "  max-width: 40rem;",
        "  margin: 4rem auto;",
        "  padding: 0 1.5rem;",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "package.json",
      contents: `${JSON.stringify(
        {
          name: "first-feature",
          version: "1.0.0",
          private: true,
          type: "module",
          scripts: { test: "node --test" },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "page.test.js",
      contents: [
        'import assert from "node:assert/strict";',
        'import { readFile } from "node:fs/promises";',
        'import { test } from "node:test";',
        "",
        'test("the page has a heading and loads its stylesheet", async () => {',
        '  const page = await readFile(new URL("./index.html", import.meta.url), "utf8");',
        "  assert.match(page, /<h1>[^<]+<\\/h1>/);",
        '  assert.match(page, /<link rel="stylesheet" href="style.css">/);',
        "});",
        "",
      ].join("\n"),
    },
  ];
}

const titleKey = (title: string) => title.trim().toLowerCase();

/** "First feature", or the first numbered name no project here holds. */
export function firstFeatureSampleName(takenTitles: Iterable<string>): string {
  const taken = new Set(Array.from(takenTitles, titleKey));
  for (let attempt = 1; attempt <= MAX_SAMPLE_NAMES; attempt++) {
    const name =
      attempt === 1 ? FIRST_FEATURE_SAMPLE_NAME : `${FIRST_FEATURE_SAMPLE_NAME} ${attempt}`;
    if (!taken.has(titleKey(name))) return name;
  }
  // A hundred samples is not a case to design for; the create then says the name is taken.
  return `${FIRST_FEATURE_SAMPLE_NAME} ${MAX_SAMPLE_NAMES + 1}`;
}

type SampleCandidate = Pick<Project, "id" | "workspaceRoot" | "workspaceSettings"> & {
  readonly deletedAt?: string | null;
};

/** Whether the project was made as the first feature sample. Renaming it changes nothing. */
export const isFirstFeatureSample = (project: {
  readonly workspaceSettings?: { readonly sample?: string | undefined } | null | undefined;
}): boolean => project.workspaceSettings?.sample === FIRST_FEATURE_SAMPLE;

/** The guide's end, when it has one this version knows. */
export function firstFeatureGuideEnd(
  guide: FirstFeatureGuide | undefined,
): FirstFeatureGuideEnd | undefined {
  return guide?.ended === "left" || guide?.ended === "finished" ? guide.ended : undefined;
}

/**
 * "The sample" on this machine (AC-12): a live project made as the sample
 * whose guide has not ended, the most recently started first. Undefined when
 * there is none, so a new one may be made.
 */
export function activeFirstFeatureSample<P extends SampleCandidate>(
  projects: ReadonlyArray<P>,
): P | undefined {
  return projects
    .filter(
      (project) =>
        (project.deletedAt ?? null) === null &&
        isFirstFeatureSample(project) &&
        firstFeatureGuideEnd(project.workspaceSettings?.firstFeatureGuide) === undefined,
    )
    .toSorted((left, right) =>
      (right.workspaceSettings?.firstFeatureGuide?.started ?? "").localeCompare(
        left.workspaceSettings?.firstFeatureGuide?.started ?? "",
      ),
    )[0];
}

/**
 * The guide's facts after a mark. `started` opens it again after it was left
 * (a new start time, no end); `left` and `finished` end it. A finished guide
 * stays finished: its end is for good (AC-12).
 */
export function firstFeatureGuideAfterMark(
  current: FirstFeatureGuide | undefined,
  mark: ProjectFirstFeatureGuideMark,
  now: string,
): FirstFeatureGuide {
  const guide = current ?? {};
  if (firstFeatureGuideEnd(guide) === "finished") return guide;
  switch (mark) {
    case "started":
      return { started: now };
    case "left":
    case "finished":
      return { ...(guide.started === undefined ? {} : { started: guide.started }), ended: mark };
  }
}

/** Why a guide mark was refused. */
export type FirstFeatureGuideRefusal = "not_found" | "not_sample";

/**
 * Records a guide mark on the sample's project record. Refused for a project
 * that is gone or was not made as the sample. A mark that changes nothing
 * writes nothing.
 */
export const markFirstFeatureGuide = Effect.fn("firstFeatureSample.markFirstFeatureGuide")(
  function* (
    projects: ProjectService.ProjectService["Service"],
    input: { readonly projectId: ProjectId; readonly mark: ProjectFirstFeatureGuideMark },
    now: string,
  ) {
    const found = yield* projects.getById(input.projectId);
    if (Option.isNone(found)) return { refused: "not_found" as FirstFeatureGuideRefusal };
    const project = found.value;
    if (!isFirstFeatureSample(project)) {
      return { refused: "not_sample" as FirstFeatureGuideRefusal };
    }
    const current = project.workspaceSettings?.firstFeatureGuide;
    const next = firstFeatureGuideAfterMark(current, input.mark, now);
    if (next.started === current?.started && next.ended === current?.ended) {
      return { firstFeatureGuide: next };
    }
    const updated = yield* projects.update({
      commandId: CommandId.make(`first-feature-guide:${input.projectId}:${input.mark}:${now}`),
      projectId: input.projectId,
      firstFeatureGuide: next,
    });
    return { firstFeatureGuide: updated.workspaceSettings?.firstFeatureGuide ?? next };
  },
);

/**
 * AC-21: the sample's own "Review finished features automatically" is off, as
 * a project override, so the only reviews are the ones its request asks for.
 * Soft, like the settings every new project is seeded with: a settings store
 * that cannot write never fails the create.
 */
export const turnOffSampleAutoReview = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    if (Option.isNone(settings)) return;
    yield* settings.value.updateSettings({
      projectSettingsOverrideChanges: {
        [projectId]: { set: { adversarialReview: { autoOnFeatureComplete: false } } },
      },
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not turn automatic review off for the sample project", {
        projectId,
        cause,
      }),
    ),
  );

/** AC-21: removing the sample removes its review override. Soft, after the delete. */
export const dropSampleAutoReview = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    if (Option.isNone(settings)) return;
    const current = yield* settings.value.getSettings;
    if (current.projectSettingsOverrides[projectId]?.adversarialReview === undefined) return;
    yield* settings.value.updateSettings({
      projectSettingsOverrideChanges: { [projectId]: { clear: ["adversarialReview"] } },
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not remove the removed sample project's review override", {
        projectId,
        cause,
      }),
    ),
  );
