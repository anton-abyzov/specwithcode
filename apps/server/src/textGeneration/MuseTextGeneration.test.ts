import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { join } from "../nodePath.ts";
import * as Effect from "effect/Effect";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import { ProviderInstanceId } from "@specweave-studio/contracts";
import { makeMuseTextGeneration } from "./MuseTextGeneration.ts";

const fs = Effect.runSync(Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((path) => Effect.runPromise(fs.remove(path, { recursive: true, force: true }))),
  );
});

async function fixture(env: Record<string, string> = {}) {
  const cwd = await Effect.runPromise(fs.makeTempDirectory({ prefix: "studio-muse-textgen-" }));
  dirs.push(cwd);
  await Effect.runPromise(
    fs.copyFile(
      fileURLToPath(
        new URL("../provider/muse/fixtures/serve.cjs", import.meta.url),
      ),
      join(cwd, "serve"),
    ),
  );
  await Effect.runPromise(
    fs.copyFile(
      fileURLToPath(
        new URL("../provider/muse/fixtures/muse-1.4.13-turn.json", import.meta.url),
      ),
      join(cwd, "muse-1.4.13-turn.json"),
    ),
  );
  return {
    cwd,
    settings: { enabled: true, binaryPath: process.execPath },
    environment: { ...process.env, MUSE_TEST_FINGERPRINT: EXPECTED_SCHEMA_FINGERPRINT, ...env },
  };
}

describe("Muse text generation", () => {
  it("generates a commit message through an ephemeral Muse session", async () => {
    const input = await fixture({
      MUSE_TEST_REPLY_TEXT: JSON.stringify({ subject: "Add the thing", body: "Why it matters." }),
    });
    const textGeneration = makeMuseTextGeneration(input.settings, input.environment);
    const result = await Effect.runPromise(
      textGeneration.generateCommitMessage({
        cwd: input.cwd,
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse-textgen-test"),
          model: "muse-wonder-1.0",
        },
        branch: "feat/thing",
        stagedSummary: "1 file changed",
        stagedPatch: "+thing",
      }),
    );
    expect(result.subject).toBe("Add the thing");
    expect(result.body).toBe("Why it matters.");
  });

  it("refuses a model the account does not offer", async () => {
    const input = await fixture();
    const textGeneration = makeMuseTextGeneration(input.settings, input.environment);
    await expect(
      Effect.runPromise(
        textGeneration.generateCommitMessage({
          cwd: input.cwd,
          modelSelection: {
            instanceId: ProviderInstanceId.make("muse-textgen-test"),
            model: "muse-does-not-exist",
          },
          branch: "feat/thing",
          stagedSummary: "1 file changed",
          stagedPatch: "+thing",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "TextGenerationError" });
  });
});
