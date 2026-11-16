import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import { ProviderInstanceId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { fileURLToPath } from "node:url";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { MuseDriver } from "./MuseDriver.ts";

const layerTest = ServerConfig.layerTest(process.cwd(), { prefix: "studio-muse-account-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);

/** `muse usage --json` as muse 1.4.20 prints it for a signed-in subscription. */
const USAGE_1_4_20 = JSON.stringify({
  schemaVersion: 1,
  allowance: {
    tier: "Muse Code Max Usage",
    window: { usedPercent: 1, resetsAtMs: 1794866434000 },
    weekly: { usedPercent: 5, resetsAtMs: 1795392000000 },
    asOfMs: 1794849529792,
    source: "mint",
  },
  reason: null,
  hint: null,
});

/**
 * A stand-in `muse` on disk: `serve` is the protocol fixture, `usage` answers
 * as 1.4.20 does while the `signed-in` file is there, and `exec` writes the
 * model catalog, as the real one downloads it. It contacts nothing.
 */
const fakeMuse = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-muse-account-" });
  yield* fs.copyFile(
    fileURLToPath(new URL("../muse/fixtures/serve.cjs", import.meta.url)),
    path.join(dir, "serve.cjs"),
  );
  yield* fs.writeFileString(path.join(dir, "usage.json"), USAGE_1_4_20);
  const binary = path.join(dir, "muse");
  yield* fs.writeFileString(
    binary,
    [
      "#!/bin/sh",
      'dir=$(dirname "$0")',
      'case "$1" in',
      // The fixture logs its requests in the folder it runs in: keep that the test's.
      `  serve) cd "$dir" && exec "${process.execPath}" "$dir/serve.cjs" ;;`,
      "  usage)",
      '    if [ -f "$dir/signed-in" ]; then cat "$dir/usage.json"; exit 0; fi',
      "    echo 'muse usage: not logged in: run `muse login` first' >&2; exit 1 ;;",
      "  exec)",
      '    pwd >> "$dir/exec-runs"; echo "$*" >> "$dir/exec-args"; : > "$dir/catalog"',
      "    echo 'agent loop failed: model failed' >&2; exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  yield* fs.chmod(binary, 0o755);
  const runs = fs.readFileString(path.join(dir, "exec-runs")).pipe(
    Effect.map((text) => text.trim().split("\n").filter(Boolean)),
    Effect.orElseSucceed(() => [] as string[]),
  );
  return {
    dir,
    binary,
    runs,
    signIn: fs.writeFileString(path.join(dir, "signed-in"), ""),
    signOut: fs.remove(path.join(dir, "signed-in"), { force: true }),
    dropCatalog: fs.remove(path.join(dir, "catalog"), { force: true }),
    environment: [
      { name: "MUSE_TEST_FINGERPRINT", value: EXPECTED_SCHEMA_FINGERPRINT, sensitive: false },
      { name: "MUSE_TEST_CATALOG_FILE", value: path.join(dir, "catalog"), sensitive: false },
      { name: "MUSE_TEST_COLD_USAGE", value: "1", sensitive: false },
      // The login file this instance watches is in the test folder, never the real one.
      { name: "XDG_CONFIG_HOME", value: path.join(dir, "config"), sensitive: false },
    ],
  };
});

it.layer(layerTest)("MuseDriver account", (it) => {
  it.effect("is signed in with its plan and models on a machine with no model list yet", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const muse = yield* fakeMuse;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* muse.signIn;
      const instance = yield* MuseDriver.create({
        instanceId: ProviderInstanceId.make("muse"),
        displayName: undefined,
        enabled: true,
        environment: muse.environment,
        config: { ...MuseDriver.defaultConfig(), binaryPath: muse.binary },
      });

      // The host lists nothing; the account answers; the list is downloaded once.
      const first = yield* instance.snapshot.refresh;
      expect(first).toMatchObject({
        installed: true,
        status: "ready",
        auth: { status: "authenticated", type: "subscription", label: "Muse Code Max Usage" },
        usageLimits: {
          windows: [
            { kind: "session", usedPercent: 1 },
            { kind: "weekly", usedPercent: 5 },
          ],
        },
      });
      expect(first.models.map((model) => model.slug)).toContain("muse-wonder-1.0");
      expect("cli" in first).toBe(false);
      const ran = yield* muse.runs;
      expect(ran.length).toBeGreaterThanOrEqual(1);
      // In a folder of the app's own, never a project.
      const own = path.join(path.basename(config.stateDir), "muse-model-list");
      expect(ran.every((folder) => folder.endsWith(own))).toBe(true);

      // Signed out in a terminal: one line, no install step.
      yield* muse.signOut;
      const out = yield* instance.snapshot.refresh;
      expect(out).toMatchObject({
        installed: true,
        status: "error",
        auth: { status: "unauthenticated", type: "subscription" },
        message: "Muse Code is not signed in. Run `muse login` in a terminal on this machine.",
      });
      expect("cli" in out).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("downloads the model list once, and again only when a person asks", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const muse = yield* fakeMuse;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* muse.signIn;
      // A download that never lands, as when the machine is offline.
      yield* fs.writeFileString(
        muse.binary,
        (yield* fs.readFileString(muse.binary)).replace(': > "$dir/catalog"', ":"),
      );
      const instance = yield* MuseDriver.create({
        instanceId: ProviderInstanceId.make("muse"),
        displayName: undefined,
        enabled: true,
        environment: muse.environment,
        config: { ...MuseDriver.defaultConfig(), binaryPath: muse.binary },
      });
      const waiting = yield* instance.snapshot.refresh;
      // Still signed in with its plan: the list is what is missing, not the sign-in.
      expect(waiting).toMatchObject({
        installed: true,
        status: "warning",
        auth: { status: "authenticated", label: "Muse Code Max Usage" },
        message:
          "Signed in to Muse Code, but its model list is not on this machine yet. Choose Check again to download it.",
      });
      const afterStart = (yield* muse.runs).length;
      yield* instance.snapshot.refresh;
      yield* instance.snapshot.refresh;
      expect((yield* muse.runs).length).toBe(afterStart);

      // Check again.
      yield* instance.invalidateCaches ?? Effect.void;
      yield* instance.snapshot.refresh;
      expect((yield* muse.runs).length).toBe(afterStart + 1);
      expect(yield* fs.readFileString(path.join(muse.dir, "exec-args"))).toContain(
        "--model specwithcode-model-list",
      );
    }).pipe(Effect.scoped),
  );
  it.effect("does not fetch a model list that went missing later until a person asks", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const muse = yield* fakeMuse;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* muse.signIn;
      // The list is already on this machine when the server starts.
      yield* fs.writeFileString(path.join(muse.dir, "catalog"), "");
      const instance = yield* MuseDriver.create({
        instanceId: ProviderInstanceId.make("muse"),
        displayName: undefined,
        enabled: true,
        environment: muse.environment,
        config: { ...MuseDriver.defaultConfig(), binaryPath: muse.binary },
      });
      expect((yield* instance.snapshot.refresh).status).toBe("ready");
      expect(yield* muse.runs).toEqual([]);

      // An update clears it. The next timed check says so and downloads nothing.
      yield* muse.dropCatalog;
      expect(yield* instance.snapshot.refresh).toMatchObject({
        status: "warning",
        auth: { status: "authenticated" },
        message:
          "Signed in to Muse Code, but its model list is not on this machine yet. Choose Check again to download it.",
      });
      expect(yield* muse.runs).toEqual([]);

      // Check again.
      yield* instance.invalidateCaches ?? Effect.void;
      expect((yield* instance.snapshot.refresh).status).toBe("ready");
      expect((yield* muse.runs).length).toBe(1);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "fetches the list at the first signed-in check after a signed-out one saw an old list",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return;
        const muse = yield* fakeMuse;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Signed out, with the list an earlier sign-in left on this machine.
        yield* fs.writeFileString(path.join(muse.dir, "catalog"), "");
        const instance = yield* MuseDriver.create({
          instanceId: ProviderInstanceId.make("muse"),
          displayName: undefined,
          enabled: true,
          environment: muse.environment,
          config: { ...MuseDriver.defaultConfig(), binaryPath: muse.binary },
        });
        expect((yield* instance.snapshot.refresh).auth.status).toBe("unauthenticated");

        // The list is cleared and the same account signs in again.
        yield* muse.dropCatalog;
        yield* muse.signIn;
        expect((yield* instance.snapshot.refresh).status).toBe("ready");
        expect((yield* muse.runs).length).toBe(1);
      }).pipe(Effect.scoped),
  );
});
