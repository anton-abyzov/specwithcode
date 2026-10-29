import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "@specweave-studio/contracts";
import { makeMetaTextGeneration, metaApiKey } from "./MetaTextGeneration.ts";

const selection = (model: string) => ({
  instanceId: ProviderInstanceId.make("muse-api-textgen-test"),
  model,
});

const commitInput = (model: string) => ({
  cwd: "/tmp",
  modelSelection: selection(model),
  branch: "feat/thing",
  stagedSummary: "1 file changed",
  stagedPatch: "+thing",
});

describe("Meta Model API text generation", () => {
  it("reads either documented API key name", () => {
    expect(metaApiKey({ META_API_KEY: " a " })).toBe("a");
    expect(metaApiKey({ MODEL_API_KEY: "b" })).toBe("b");
    expect(metaApiKey({})).toBeUndefined();
  });

  it("generates a commit message from a chat completions reply", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const textGeneration = makeMetaTextGeneration(
      { META_API_KEY: "test-key" },
      async (url, init) => {
        seen.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ subject: "Add the thing", body: "" }) } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const result = await Effect.runPromise(
      textGeneration.generateCommitMessage(commitInput("muse-wonder-1.0")),
    );
    expect(result.subject).toBe("Add the thing");
    expect(seen[0]?.url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(seen[0]?.body.model).toBe("muse-wonder-1.0");
  });

  it("refuses Wonder Full on the API and reports HTTP failures without leaking detail", async () => {
    const textGeneration = makeMetaTextGeneration({ META_API_KEY: "test-key" }, async () =>
      new Response("upstream detail", { status: 500 }),
    );
    await expect(
      Effect.runPromise(textGeneration.generateCommitMessage(commitInput("muse-wonder-full-1.0"))),
    ).rejects.toMatchObject({
      _tag: "TextGenerationError",
      detail: expect.stringContaining("not available on the Meta Model API"),
    });
    await expect(
      Effect.runPromise(textGeneration.generateCommitMessage(commitInput("muse-spark-1.3"))),
    ).rejects.toMatchObject({
      _tag: "TextGenerationError",
      detail: expect.stringContaining("HTTP 500"),
    });
  });

  it("fails clearly without a key", async () => {
    const textGeneration = makeMetaTextGeneration({}, async () => new Response("{}"));
    await expect(
      Effect.runPromise(textGeneration.generateCommitMessage(commitInput("muse-spark-1.3"))),
    ).rejects.toMatchObject({
      _tag: "TextGenerationError",
      detail: expect.stringContaining("No Meta API key"),
    });
  });
});
