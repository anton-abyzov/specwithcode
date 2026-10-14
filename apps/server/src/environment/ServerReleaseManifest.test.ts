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
