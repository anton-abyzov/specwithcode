import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as NetService from "@specweave-studio/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { describe, expect } from "vite-plus/test";

import { makeCli } from "../binCli.ts";
import { invokedCliName } from "./cliName.ts";

describe("invokedCliName", () => {
  it("prefers the name a Studio launcher passes in", () => {
    expect(invokedCliName({ env: "specwithcode", argv1: "/r/releases/abc/bin.mjs" })).toBe(
      "specwithcode",
    );
    expect(invokedCliName({ env: "specweave-studio", argv1: "/usr/local/bin/specwithcode" })).toBe(
      "specweave-studio",
    );
  });

  it("falls back to the linked bin name, then to specweave-studio", () => {
    expect(invokedCliName({ argv1: "/usr/local/bin/specwithcode" })).toBe("specwithcode");
    expect(invokedCliName({ argv1: "C:\\npm\\specwithcode.js" })).toBe("specwithcode");
    expect(invokedCliName({ argv1: "/usr/local/bin/specweave-studio" })).toBe("specweave-studio");
    expect(invokedCliName({ argv1: "/r/releases/abc/bin.mjs" })).toBe("specweave-studio");
    expect(invokedCliName({})).toBe("specweave-studio");
  });

  it("never prints a name other than the two Studio names", () => {
    expect(invokedCliName({ env: "rm -rf", argv1: "/tmp/evil" })).toBe("specweave-studio");
    expect(invokedCliName({ env: "", argv1: "/usr/local/bin/specwithcode" })).toBe("specwithcode");
  });
});

const printedVersion = (name: Parameters<typeof makeCli>[0]) =>
  Effect.gen(function* () {
    yield* Command.runWith(makeCli(name), { version: "9.8.7" })(["--version"]);
    const lines = yield* TestConsole.logLines;
    return lines.map(String).join("\n");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)));

describe("--version", () => {
  it.effect.each([
    { name: "specwithcode", expected: "specwithcode v9.8.7" },
    { name: "specweave-studio", expected: "specweave-studio v9.8.7" },
    { name: undefined, expected: "specweave-studio v9.8.7" },
  ] as const)("prints $expected when invoked as $name", ({ name, expected }) =>
    Effect.gen(function* () {
      expect(yield* printedVersion(name === undefined ? undefined : { name })).toBe(expected);
    }),
  );
});
