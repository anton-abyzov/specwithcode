// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ComposerDraftGetInput, ComposerDraftKeyInput } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeComposerDrafts } from "./ComposerDrafts.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-drafts-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const key = "coordinator:project-1" as ComposerDraftKeyInput["key"];

describe("composerDrafts.get with metadataOnly", () => {
  it("answers without attachment bytes, and with them otherwise", async () => {
    const drafts = makeComposerDrafts(dir);
    await Effect.runPromise(
      drafts.put({
        key,
        prompt: "Use M5",
        editedAt: 10,
        attachments: [
          {
            id: "shot",
            type: "image",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dataBase64: Buffer.from([1, 2, 3]).toString("base64"),
          },
        ],
      }),
    );
    const light = await Effect.runPromise(drafts.get({ key, metadataOnly: true }));
    expect(light.draft?.prompt).toBe("Use M5");
    expect(light.draft?.attachments.map((attachment) => attachment.dataBase64)).toEqual([""]);
    const full = await Effect.runPromise(drafts.get({ key }));
    expect(full.draft?.attachments[0]?.dataBase64).toBe("AQID");
  });

  it("an older host's payload schema accepts the new field", () => {
    // Hosts before metadataOnly decode the get payload as ComposerDraftKeyInput.
    const input = Schema.decodeUnknownSync(ComposerDraftKeyInput)({ key, metadataOnly: true });
    expect(input).toEqual({ key });
    expect(Schema.decodeUnknownSync(ComposerDraftGetInput)({ key, metadataOnly: true })).toEqual({
      key,
      metadataOnly: true,
    });
  });
});
