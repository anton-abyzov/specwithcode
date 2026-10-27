import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AcpRegistrySettings, ProviderInstanceId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import {
  forgetVerifiedCredential,
  makeAcpRegistryAuthenticationState,
  rememberVerifiedCredential,
} from "./AcpRegistryAuthenticationState.ts";

const settings = Schema.decodeSync(AcpRegistrySettings)({ agentId: "devin" });

it.layer(NodeServices.layer)("ACP sign-in confirmation", (it) => {
  it.effect("restores explicit sign-in across driver recreation and server restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const input = {
        cacheDir,
        instanceId: ProviderInstanceId.make("acp_devin"),
        settings,
        environment: [],
        processEnvironment: { HOME: "/home/test" },
      };
      const first = yield* makeAcpRegistryAuthenticationState(input);
      assert.isFalse(yield* first.get);
      yield* first.set(true);
      const recreated = yield* makeAcpRegistryAuthenticationState({
        ...input,
        settings: { ...settings, customModels: ["new-model"] },
      });
      assert.isTrue(yield* recreated.get);
      // Both logout and an explicit authentication failure revoke confirmation.
      yield* recreated.set(false);
      const restarted = yield* makeAcpRegistryAuthenticationState(input);
      assert.isFalse(yield* restarted.get);
    }),
  );

  it.effect(
    "does not carry confirmation to a different agent, method, executable, or credential environment",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheDir = yield* fs.makeTempDirectoryScoped();
        const input = {
          cacheDir,
          instanceId: ProviderInstanceId.make("acp_devin"),
          settings,
          environment: [{ name: "DEVIN_TOKEN", value: "test-only-token", sensitive: true }],
          processEnvironment: { HOME: "/home/test" },
        };
        for (const change of [
          { settings: { ...settings, agentId: "other-agent" } },
          { settings: { ...settings, authMethodId: "enterprise" } },
          { settings: { ...settings, commandPath: "/other/devin" } },
          { environment: [{ name: "DEVIN_TOKEN", value: "different-token", sensitive: true }] },
          { processEnvironment: { HOME: "/home/other" } },
        ]) {
          const signedIn = yield* makeAcpRegistryAuthenticationState(input);
          yield* signedIn.set(true);
          const changed = yield* makeAcpRegistryAuthenticationState({ ...input, ...change });
          assert.isFalse(yield* changed.get);
          const restoredConfig = yield* makeAcpRegistryAuthenticationState(input);
          assert.isFalse(yield* restoredConfig.get);
        }
        for (const name of yield* fs.readDirectory(cacheDir)) {
          const contents = yield* fs.readFileString(`${cacheDir}/${name}`);
          assert.isFalse(contents.includes("test-only-token"));
          assert.isFalse(contents.includes("different-token"));
        }
      }),
  );

  it.effect("ignores damaged confirmation and keeps another instance independent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const input = {
        cacheDir,
        instanceId: ProviderInstanceId.make("acp_devin"),
        settings,
        environment: [],
        processEnvironment: {},
      };
      const first = yield* makeAcpRegistryAuthenticationState(input);
      yield* first.set(true);
      const other = yield* makeAcpRegistryAuthenticationState({
        ...input,
        instanceId: ProviderInstanceId.make("acp_other"),
      });
      assert.isFalse(yield* other.get);
      for (const name of yield* fs.readDirectory(cacheDir)) {
        yield* fs.writeFileString(`${cacheDir}/${name}`, "invalid");
      }
      const restored = yield* makeAcpRegistryAuthenticationState(input);
      assert.isFalse(yield* restored.get);
    }),
  );
  it.effect("confirms the rebuilt instance that holds the API key verified at sign-in", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const instanceId = ProviderInstanceId.make("acp_gemini");
      const key = "AIza-verified-test-key";
      const saved = {
        cacheDir,
        instanceId,
        settings: { ...settings, agentId: "gemini", authMethodId: "gemini-api-key" },
        environment: [{ name: "GEMINI_API_KEY", value: key, sensitive: true }],
        processEnvironment: { HOME: "/home/test", GEMINI_API_KEY: key },
      };
      const note = { cacheDir, instanceId, authMethodId: "gemini-api-key" };
      yield* rememberVerifiedCredential({ ...note, envName: "GEMINI_API_KEY", value: key });
      for (const name of yield* fs.readDirectory(cacheDir)) {
        assert.isFalse((yield* fs.readFileString(`${cacheDir}/${name}`)).includes(key));
      }
      // A different key or method does not use the note.
      const otherKey = yield* makeAcpRegistryAuthenticationState({
        ...saved,
        processEnvironment: { HOME: "/home/test", GEMINI_API_KEY: "AIza-other" },
      });
      assert.isFalse(yield* otherKey.get);
      const rebuilt = yield* makeAcpRegistryAuthenticationState(saved);
      assert.isTrue(yield* rebuilt.get);
      // The note is used once; the confirmation itself persists.
      assert.isTrue(yield* (yield* makeAcpRegistryAuthenticationState(saved)).get);
      yield* rememberVerifiedCredential({ ...note, envName: "GEMINI_API_KEY", value: key });
      yield* forgetVerifiedCredential({ cacheDir, instanceId });
      yield* (yield* makeAcpRegistryAuthenticationState(saved)).set(false);
      assert.isFalse(yield* (yield* makeAcpRegistryAuthenticationState(saved)).get);
    }),
  );
});
