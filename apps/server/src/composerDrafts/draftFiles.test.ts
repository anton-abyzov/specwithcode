// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { draftFolder, listDrafts, putDraft, readDraftWithData, removeDraft } from "./draftFiles.ts";

const png = (seed: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, seed, seed + 1, seed + 2]);
const image = (id: string, data?: Uint8Array) => ({
  id,
  type: "image" as const,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 7,
  ...(data ? { data } : {}),
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-drafts-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("composer draft files", () => {
  it("keeps text and attachment bytes, and bumps the revision on every save", async () => {
    const first = await putDraft(
      dir,
      { key: "thread:t1", prompt: "hello", attachments: [image("a", png(1))], editedAt: 10 },
      100,
    );
    expect(first).toEqual({ revision: 1, missingAttachmentIds: [] });
    // The second save names the stored image without resending its bytes.
    const second = await putDraft(
      dir,
      { key: "thread:t1", prompt: "hello world", attachments: [image("a")], editedAt: 20 },
      200,
    );
    expect(second).toEqual({ revision: 2, missingAttachmentIds: [] });

    const draft = await readDraftWithData(dir, "thread:t1");
    expect(draft?.prompt).toBe("hello world");
    expect(draft?.editedAt).toBe(20);
    expect(draft?.attachments.map((attachment) => attachment.id)).toEqual(["a"]);
    expect([...draft!.data.get("a")!]).toEqual([...png(1)]);
  });

  it("reports attachments it does not hold and prunes removed ones", async () => {
    await putDraft(
      dir,
      {
        key: "coordinator:p1",
        prompt: "x",
        attachments: [image("a", png(1)), image("b", png(2))],
        editedAt: 1,
      },
      1,
    );
    const result = await putDraft(
      dir,
      { key: "coordinator:p1", prompt: "x", attachments: [image("b"), image("c")], editedAt: 2 },
      2,
    );
    expect(result.missingAttachmentIds).toEqual(["c"]);
    const files = await fs.readdir(draftFolder(dir, "coordinator:p1"));
    expect(files.sort()).toEqual(["b.bin", "draft.json"]);
  });

  it("removes the draft when it is saved empty or deleted", async () => {
    await putDraft(dir, { key: "draft:d1", prompt: "a", attachments: [], editedAt: 1 }, 1);
    await putDraft(dir, { key: "draft:d2", prompt: "b", attachments: [], editedAt: 1 }, 1);
    await putDraft(dir, { key: "draft:d1", prompt: "  ", attachments: [], editedAt: 2 }, 2);
    await removeDraft(dir, "draft:d2");
    expect(await listDrafts(dir)).toEqual([]);
  });

  it("serializes concurrent saves of one draft", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        putDraft(
          dir,
          {
            key: "thread:t2",
            prompt: `v${index}`,
            attachments: [image(`i${index}`, png(index))],
            editedAt: index,
          },
          index,
        ),
      ),
    );
    const draft = await readDraftWithData(dir, "thread:t2");
    expect(draft?.revision).toBe(10);
    expect(draft?.prompt).toBe("v9");
    expect(await fs.readdir(draftFolder(dir, "thread:t2"))).toEqual(["draft.json", "i9.bin"]);
  });

  it("survives kill -9 of the process right after a save returns", async () => {
    const moduleUrl = new URL("./draftFiles.ts", import.meta.url).href;
    const script = `
      import { putDraft } from ${JSON.stringify(moduleUrl)};
      const bytes = new Uint8Array(512 * 1024).map((_, i) => i % 251);
      await putDraft(${JSON.stringify(dir)}, {
        key: "thread:killed",
        prompt: "typed before the crash",
        attachments: [{ id: "shot", type: "image", name: "shot.png", mimeType: "image/png", sizeBytes: bytes.length, data: bytes }],
        editedAt: 42,
      }, 42);
      process.stdout.write("saved\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("saved")) resolve();
      });
      child.on("exit", (code) => reject(new Error(`child exited ${code}: ${stderr}`)));
    });
    const exited = new Promise((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    // Stop exactly the process this test started.
    process.kill(child.pid!, "SIGKILL");
    expect(await exited).toBe("SIGKILL");

    const draft = await readDraftWithData(dir, "thread:killed");
    expect(draft?.prompt).toBe("typed before the crash");
    expect(draft?.data.get("shot")?.byteLength).toBe(512 * 1024);
    expect(draft?.data.get("shot")?.[300]).toBe(300 % 251);
  }, 20_000);
});
