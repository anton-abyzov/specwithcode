/**
 * The member's verified-skill.com API token (`vsk_…`), as `vskill auth login`
 * stores it: the documented fallback file first, then the macOS keychain.
 * Never returned to a client; callers send it to verified-skill.com only.
 *
 * @module project/vskillApiToken
 */
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";

export const VSKILL_API_TOKEN_PATTERN = /^vsk_[A-Za-z0-9_-]+$/;

export const readVskillApiToken: Effect.Effect<
  string | undefined,
  never,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const stored = yield* fs
    .readFileString(path.join(expandHomePath("~"), ".vskill", "keys.env"))
    .pipe(Effect.orElseSucceed(() => ""));
  const match = stored.match(/^vskill-api-token=(vsk_[A-Za-z0-9_-]+)\s*$/m);
  if (match) return match[1];
  if (platform === "darwin") {
    const key = yield* runner
      .run({
        command: "security",
        args: ["find-generic-password", "-s", "vskill-token", "-a", "vskill-api-token", "-w"],
        timeout: "10 seconds",
        maxOutputBytes: 4096,
      })
      .pipe(Effect.option);
    if (
      key._tag === "Some" &&
      Number(key.value.code) === 0 &&
      VSKILL_API_TOKEN_PATTERN.test(key.value.stdout.trim())
    )
      return key.value.stdout.trim();
  }
  return undefined;
});
