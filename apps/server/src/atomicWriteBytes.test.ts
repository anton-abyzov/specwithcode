import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

import { writeFileBytesAtomically } from "./atomicWriteBytes.ts";

it.layer(NodeServices.layer)("writeFileBytesAtomically", (it) => {
  it.effect.skipIf(process.platform === "win32")(
    "keeps the replaced file's mode and creates a new file owner-only",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-bytes-" });
        const secret = path.join(root, "secret.xlsx");
        const shared = path.join(root, "shared.xlsx");
        const fresh = path.join(root, "fresh.xlsx");
        yield* fs.writeFileString(secret, "before");
        yield* fs.chmod(secret, 0o600);
        yield* fs.writeFileString(shared, "before");
        yield* fs.chmod(shared, 0o644);

        const contents = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        for (const filePath of [secret, shared, fresh]) {
          yield* writeFileBytesAtomically({ filePath, contents });
          assert.deepStrictEqual(yield* fs.readFile(filePath), contents);
        }
        const mode = (filePath: string) =>
          fs.stat(filePath).pipe(Effect.map((info) => info.mode & 0o777));
        assert.equal(yield* mode(secret), 0o600);
        assert.equal(yield* mode(shared), 0o644);
        assert.equal(yield* mode(fresh), 0o600);
      }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, process.platform)),
  );
});
