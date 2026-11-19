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
  activeFirstFeatureSample,
  CommandId,
  firstFeatureGuideAfterMark,
  firstFeatureGuideEnd,
  firstFeatureGuideFinishedIn,
  isFirstFeatureSample,
  ProjectWorkspaceError,
  sameFirstFeatureGuide,
  type ProjectFirstFeatureGuideInput,
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

/**
 * "The sample" on this machine (AC-12) and whether it is one: the rules live in
 * contracts so the window reads the same. `firstFeatureGuideFinishedIn` is
 * what `serverConfig.firstFeatureFinished` says over every project row.
 */
export { activeFirstFeatureSample, firstFeatureGuideFinishedIn, isFirstFeatureSample };

/** Planned against the stored facts when the mark commits; see the contract. */
export { firstFeatureGuideAfterMark, firstFeatureGuideEnd };

/** Why a guide mark was refused. */
export type FirstFeatureGuideRefusal = "not_found" | "not_sample";

/**
 * Records a guide mark on the sample's project record. Refused for a project
 * that is gone or was not made as the sample. The transition is planned again
 * against the stored facts when the update commits, so a stale window's mark
 * cannot reopen a finished guide. A mark that changes nothing writes nothing.
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
    if (sameFirstFeatureGuide(next, current)) return { firstFeatureGuide: current ?? {} };
    const updated = yield* projects.update({
      commandId: CommandId.make(`first-feature-guide:${input.projectId}:${input.mark}:${now}`),
      projectId: input.projectId,
      firstFeatureGuideMark: { mark: input.mark, at: now },
    });
    return { firstFeatureGuide: updated.workspaceSettings?.firstFeatureGuide ?? next };
  },
);

/**
 * `projects.firstFeatureGuide`: a mark, with a project that is gone said as
 * `not_found`, one that is not the sample as `invalid`, and any other failure
 * as `operation_failed`.
 */
export const firstFeatureGuideRpc = (
  projects: ProjectService.ProjectService["Service"],
  input: ProjectFirstFeatureGuideInput,
  now: string,
) =>
  markFirstFeatureGuide(projects, input, now).pipe(
    Effect.mapError(
      () => new ProjectWorkspaceError({ code: "operation_failed", projectId: input.projectId }),
    ),
    Effect.flatMap((marked) =>
      "refused" in marked
        ? Effect.fail(
            new ProjectWorkspaceError({
              code: marked.refused === "not_found" ? "not_found" : "invalid",
              projectId: input.projectId,
            }),
          )
        : Effect.succeed({ firstFeatureGuide: marked.firstFeatureGuide }),
    ),
  );

/** What the create result says when the sample's review switch could not be turned off. */
export const SAMPLE_AUTO_REVIEW_ERROR =
  "Automatic review could not be turned off for this project, so a review may start by itself when the work finishes. Turn it off in the project's settings.";

/**
 * AC-21: the sample's own "Review finished features automatically" is off, as
 * a project override, so the only reviews are the ones its request asks for.
 * Soft, like the settings every new project is seeded with: it never fails
 * the create, and returns SAMPLE_AUTO_REVIEW_ERROR when the switch stays as it was.
 */
export const turnOffSampleAutoReview = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    if (Option.isNone(settings)) {
      yield* Effect.logWarning("No settings service: the sample project's review stays as set", {
        projectId,
      });
      return SAMPLE_AUTO_REVIEW_ERROR;
    }
    yield* settings.value.updateSettings({
      projectSettingsOverrideChanges: {
        [projectId]: { set: { adversarialReview: { autoOnFeatureComplete: false } } },
      },
    });
    return undefined;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not turn automatic review off for the sample project", {
        projectId,
        cause,
      }).pipe(Effect.as(SAMPLE_AUTO_REVIEW_ERROR)),
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
