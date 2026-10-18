import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessArguments } from "@specweave-studio/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixture files independently verify the Effect release-manifest reader.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { nodePath as NodePath } from "../nodePath.ts";
import { pathToFileURL } from "node:url";

import {
  findNpmPackageRuntime,
  parseNpmReleaseVersion,
  parseReleaseSourceCommit,
  readServerReleaseSourceCommit,
  SERVER_RELEASE_MANIFEST,
} from "./ServerReleaseManifest.ts";

const COMMIT = "fb8ab7f8a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5";

it("accepts only a Studio manifest with a full commit", () => {
  expect(
    parseReleaseSourceCommit(JSON.stringify({ product: "SpecWeave Studio", sourceCommit: COMMIT })),
  ).toBe(COMMIT);
  expect(
    parseReleaseSourceCommit(JSON.stringify({ product: "Other", sourceCommit: COMMIT })),
  ).toBeNull();
  expect(
    parseReleaseSourceCommit(
      JSON.stringify({ product: "SpecWeave Studio", sourceCommit: "fb8ab7f" }),
    ),
  ).toBeNull();
  expect(parseReleaseSourceCommit("not json")).toBeNull();
});

it.effect("reads the commit from the manifest beside the release entry", () =>
  Effect.gen(function* () {
    const release = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-release-"));
    const empty = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-module-"));
    NodeFS.writeFileSync(
      NodePath.join(release, SERVER_RELEASE_MANIFEST),
      JSON.stringify({ product: "SpecWeave Studio", sourceCommit: COMMIT }),
    );
    const moduleUrl = pathToFileURL(NodePath.join(empty, "chunk.mjs")).href;

    const fromEntry = yield* readServerReleaseSourceCommit(moduleUrl).pipe(
      Effect.provideService(HostProcessArguments, ["node", NodePath.join(release, "bin.mjs")]),
    );
    const fromModule = yield* readServerReleaseSourceCommit(
      pathToFileURL(NodePath.join(release, "chunk.mjs")).href,
    ).pipe(Effect.provideService(HostProcessArguments, ["node"]));
    const absent = yield* readServerReleaseSourceCommit(moduleUrl).pipe(
      Effect.provideService(HostProcessArguments, ["node", NodePath.join(empty, "bin.mjs")]),
    );

    expect(fromEntry).toBe(COMMIT);
    expect(fromModule).toBe(COMMIT);
    expect(absent).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("recognises only the manifest the npm package build writes", () => {
  const npm = {
    schemaVersion: 1,
    product: "SpecWeave Studio",
    version: "1.0.43",
    sourceCommit: COMMIT,
  };
  expect(parseNpmReleaseVersion(JSON.stringify({ ...npm, distribution: "npm" }))).toBe("1.0.43");
  expect(parseNpmReleaseVersion(JSON.stringify(npm))).toBeNull();
  expect(
    parseNpmReleaseVersion(JSON.stringify({ ...npm, product: "Other", distribution: "npm" })),
  ).toBeNull();
  expect(parseNpmReleaseVersion("not json")).toBeNull();
});

it.effect("finds the npm package through the global bin symlink", () =>
  Effect.gen(function* () {
    const prefix = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-npm-prefix-")),
    );
    const pkg = NodePath.join(prefix, "lib", "node_modules", "specwithcode");
    NodeFS.mkdirSync(pkg, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(prefix, "bin"));
    NodeFS.writeFileSync(NodePath.join(pkg, "bin.mjs"), "");
    NodeFS.writeFileSync(
      NodePath.join(pkg, SERVER_RELEASE_MANIFEST),
      JSON.stringify({ product: "SpecWeave Studio", version: "1.0.43", distribution: "npm" }),
    );
    const bin = NodePath.join(prefix, "bin", "specwithcode");
    NodeFS.symlinkSync("../lib/node_modules/specwithcode/bin.mjs", bin);
    const elsewhere = pathToFileURL(NodePath.join(prefix, "chunk.mjs")).href;

    const found = yield* findNpmPackageRuntime(elsewhere).pipe(
      Effect.provideService(HostProcessArguments, ["node", bin]),
    );
    NodeFS.writeFileSync(
      NodePath.join(pkg, SERVER_RELEASE_MANIFEST),
      JSON.stringify({ product: "SpecWeave Studio", version: "1.0.43", sourceCommit: COMMIT }),
    );
    const archive = yield* findNpmPackageRuntime(elsewhere).pipe(
      Effect.provideService(HostProcessArguments, ["node", bin]),
    );

    expect(found).toEqual({ dir: pkg, version: "1.0.43" });
    expect(archive).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer)),
);
