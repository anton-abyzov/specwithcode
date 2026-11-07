import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectWorkspaceError } from "@specweave-studio/contracts";
import { Effect, FileSystem, Path } from "effect";

describe("ProjectWorkspaceError codes on iOS", () => {
  it.effect("gives every code a sentence, since the server sends only the code", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const swift = yield* fileSystem.readFileString(
        path.join(import.meta.dirname, "../../../ios/SWCKit/Sources/SWCWire/Core.swift"),
      );
      const codes = ProjectWorkspaceError.fields.code.literals;
      expect(codes).toContain("provider_unavailable");
      expect(codes.filter((code) => !swift.includes(`case "${code}":`))).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
