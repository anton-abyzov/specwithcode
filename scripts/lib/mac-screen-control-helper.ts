/**
 * The macOS input helper for screen control (1519, `native/screen-control/main.swift`):
 * built with swiftc for each target, joined into one binary, and shipped at
 * `Resources/screen-control`, where the app's signing covers it as it covers
 * the voice helper.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";

export const MAC_SCREEN_CONTROL_EXECUTABLE_NAME = "studio-screen-control";
export const MAC_SCREEN_CONTROL_EXTRA_RESOURCES = [
  { from: "apps/desktop/prod-resources/screen-control", to: "screen-control" },
] as const;
/** Kept out of app.asar: it ships once, through `MAC_SCREEN_CONTROL_EXTRA_RESOURCES`. */
export const MAC_SCREEN_CONTROL_FILE_EXCLUSIONS = [
  "!apps/desktop/prod-resources/screen-control",
  "!apps/desktop/prod-resources/screen-control/**/*",
] as const;
/** Oldest macOS the helper runs on: the same as the voice helper's. */
export const MAC_SCREEN_CONTROL_DEPLOYMENT_TARGET = "12.0";

export function macScreenControlTargets(
  arch: "arm64" | "x64" | "universal" | string,
): ReadonlyArray<string> {
  const triple = (cpu: string) => `${cpu}-apple-macos${MAC_SCREEN_CONTROL_DEPLOYMENT_TARGET}`;
  if (arch === "universal") return [triple("arm64"), triple("x86_64")];
  return [triple(arch === "arm64" ? "arm64" : "x86_64")];
}

export const stageMacScreenControlHelper = Effect.fn("stageMacScreenControlHelper")(function* <
  E,
  R,
>(input: {
  readonly repoRoot: string;
  readonly destinationDirectory: string;
  readonly arch: string;
  readonly run: (command: ChildProcess.Command, label: string) => Effect.Effect<unknown, E, R>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = path.join(input.repoRoot, "native/screen-control/main.swift");
  const buildDirectory = path.join(input.destinationDirectory, ".build");
  yield* fs
    .remove(input.destinationDirectory, { recursive: true, force: true })
    .pipe(Effect.ignore);
  yield* fs.makeDirectory(buildDirectory, { recursive: true });
  const built: Array<string> = [];
  for (const target of macScreenControlTargets(input.arch)) {
    const output = path.join(buildDirectory, `${MAC_SCREEN_CONTROL_EXECUTABLE_NAME}-${target}`);
    yield* input.run(
      ChildProcess.make(
        "xcrun",
        ["--sdk", "macosx", "swiftc", "-O", "-target", target, "-o", output, source],
        { cwd: input.repoRoot },
      ),
      `swiftc screen control helper (${target})`,
    );
    built.push(output);
  }
  const destination = path.join(input.destinationDirectory, MAC_SCREEN_CONTROL_EXECUTABLE_NAME);
  if (built.length === 1) yield* fs.copyFile(built[0]!, destination);
  else
    yield* input.run(
      ChildProcess.make("lipo", ["-create", ...built, "-output", destination]),
      "lipo screen control helper universal binary",
    );
  yield* fs.remove(buildDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.chmod(destination, 0o755);
});
