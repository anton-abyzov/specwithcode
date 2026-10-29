// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - isolated actual source/destination HTTP copy regressions.
import * as Crypto from "node:crypto";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { folderCopyAllConflictsKey } from "@specweave-studio/contracts";
import { FOLDER_TRANSFER_PREFIX } from "./wire.ts";
import { DEFAULT_SELECTION } from "./classify.ts";
import { DestinationCopies } from "./destinationService.ts";
import { git } from "./folderFixture.testkit.ts";
import { SourceTransfers } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";
import { readManifestFile, writeManifest } from "./manifest.ts";

let base: string;
let folder: string;
let target: string;
let state: string;
let id: string;
let sources: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
let copies: DestinationCopies;
let churn = false;
let changes = 0;
beforeEach(async () => {
  base = await FSP.realpath(await FSP.mkdtemp(Path.join(OS.tmpdir(), "swc-snapshot-http-")));
  folder = Path.join(base, "source");
  target = Path.join(base, "destination");
  state = Path.join(base, "source-state");
  await FSP.mkdir(folder);
  await FSP.mkdir(target);
  await FSP.mkdir(Path.join(folder, ".specweave"));
  await FSP.writeFile(Path.join(folder, "README.md"), "reviewed source\n");
  await FSP.writeFile(Path.join(folder, ".specweave", "ledger.jsonl"), "reviewed ledger\n");
  await FSP.writeFile(Path.join(folder, ".env"), "EXAMPLE_PRIVATE=not-approved\n");
  await FSP.mkdir(Path.join(folder, "scripts"));
  await FSP.writeFile(
    Path.join(folder, "scripts", ".cf-monitor.env"),
    "SYNTHETIC_ONLY=not-approved\n",
  );
  git(folder, "init", "-q");
  git(folder, "add", "README.md");
  git(folder, "commit", "-qm", "initial");
  await FSP.writeFile(Path.join(target, "README.md"), "existing destination work\n");
  id = Crypto.randomUUID();
  churn = false;
  changes = 0;
  sources = new SourceTransfers(state);
  served = await serveSource(sources, "source-env");
  copies = new DestinationCopies(Path.join(base, "destination-state"), {
    allowLoopback: true,
    pollMs: 1,
    sleep: async () => {},
    fetch: async (input, init) => {
      if (churn) {
        changes++;
        await FSP.writeFile(
          Path.join(folder, ".specweave", "ledger.jsonl"),
          `later ledger ${changes}\n`,
        );
        await FSP.writeFile(Path.join(folder, ".env"), `EXAMPLE_PRIVATE=later-${changes}\n`);
      }
      return fetch(input, init);
    },
  });
});
afterEach(async () => {
  await copies?.close();
  await sources?.close();
  await served?.close();
  await FSP.rm(base, { recursive: true, force: true });
});
async function settle(states: string[]) {
  for (let i = 0; i < 300; i++) {
    await copies.waitFor(id);
    const record = await copies.read(id);
    if (record && states.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Copy did not settle");
}
async function prepare(restart = false, legacy = false) {
  const offer = await sources.offer({
    operationId: id,
    projectId: "source-project",
    folder,
    mode: "copy-only",
    destinationEnvironmentId: "destination-env",
  });
  if (restart || legacy) {
    const loaded = await sources.authorize(id, offer.token);
    await sources.requestManifest(loaded, DEFAULT_SELECTION);
    await loaded.building;
    expect(loaded.record.state).toBe("ready");
    await served.close();
    await sources.close();
    if (legacy) {
      const { capturedSource: _captured, ...oldRecord } = loaded.record;
      await FSP.writeFile(
        Path.join(state, "folder-sources", id, "operation.json"),
        JSON.stringify(oldRecord),
      );
    }
    sources = new SourceTransfers(state);
    served = await serveSource(sources, "source-env");
  }
  await copies.start({
    operationId: id,
    sourceUrl: served.url,
    token: offer.token,
    sourceEnvironmentId: "source-env",
    sourceProjectId: "source-project",
    sourceMachine: "Source",
    mode: "copy-only",
    targetFolder: target,
    title: "Captured copy",
  });
  const initial = await settle(["previewed", "failed"]);
  expect(initial.state, JSON.stringify(initial.error)).toBe("previewed");
  const plan = (await copies.readPlan(id))!;
  await copies.decide(id, {
    decisions: Object.fromEntries(
      plan.rows.flatMap((row) => [
        [row.id, "take-theirs"],
        [folderCopyAllConflictsKey(row.id), "take-theirs"],
      ]),
    ),
  });
  expect((await settle(["previewed", "failed"])).state).toBe("previewed");
  return offer;
}
it("copies exactly reviewed bytes to an existing destination despite continuous selected and unselected churn", async () => {
  await prepare(true);
  const before = await sources.read(id);
  expect(before?.capturedSource?.version).toBe(1);
  expect((await copies.read(id))?.capturedAt).toBe(before?.capturedSource?.capturedAt);
  await FSP.writeFile(Path.join(folder, "README.md"), "newer source\n");
  await FSP.writeFile(Path.join(folder, "added-after-review.txt"), "later\n");
  git(folder, "add", "README.md");
  git(folder, "commit", "-qm", "later source commit");
  expect((await sources.checkScan(id))?.freshness?.current).toBe(false);
  churn = true;
  await copies.approve(id);
  const done = await settle(["applied", "failed"]);
  expect(done.state).toBe("applied");
  expect(changes).toBeGreaterThan(2);
  expect(await FSP.readFile(Path.join(target, "README.md"), "utf8")).toBe("reviewed source\n");
  expect(await FSP.readFile(Path.join(target, ".specweave", "ledger.jsonl"), "utf8")).toBe(
    "reviewed ledger\n",
  );
  await expect(FSP.stat(Path.join(target, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(FSP.stat(Path.join(target, "scripts", ".cf-monitor.env"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(FSP.stat(Path.join(target, "added-after-review.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await FSP.readFile(Path.join(folder, "README.md"), "utf8")).toBe("newer source\n");
  await expect(
    FSP.stat(Path.join(state, "folder-sources", id, "captured-files")),
  ).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);
it("still refuses changed destination work and preserves the reviewed conflict choices", async () => {
  await prepare();
  const before = await copies.read(id);
  await FSP.writeFile(Path.join(target, "README.md"), "new local work\n");
  await expect(copies.approve(id)).rejects.toThrow(/destination changed/);
  expect((await copies.read(id))?.decisions).toEqual(before?.decisions);
  expect(await FSP.readFile(Path.join(target, "README.md"), "utf8")).toBe("new local work\n");
}, 30_000);
it.each(["missing", "corrupt"])(
  "refuses %s captured backing without reading newer source bytes",
  async (kind) => {
    await prepare();
    const pack = Path.join(state, "folder-sources", id, "captured-files", "files.pack");
    if (kind === "missing") await FSP.unlink(pack);
    else await FSP.writeFile(pack, "corrupt");
    await FSP.writeFile(Path.join(folder, "README.md"), "newer source\n");
    await expect(copies.approve(id)).rejects.toThrow(/captured copy files/);
    expect((await copies.read(id))?.state).toBe("previewed");
    expect(await FSP.readFile(Path.join(target, "README.md"), "utf8")).toBe(
      "existing destination work\n",
    );
  },
  30_000,
);
it("keeps legacy resumed jobs strict and cancels only generated backing", async () => {
  await prepare(false, true);
  await FSP.writeFile(Path.join(folder, "README.md"), "later source\n");
  await expect(copies.approve(id)).rejects.toThrow(/source changed/);
  const manifest = await readManifestFile(
    Path.join(state, "folder-sources", id, "manifest.ndjson.gz"),
  );
  expect(manifest.entries.some((entry) => entry.path === ".env")).toBe(false);
  await sources.cancel(id, "fixture cleanup");
  await expect(
    FSP.stat(Path.join(state, "folder-sources", id, "captured-files")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await FSP.readFile(Path.join(folder, "README.md"), "utf8")).toBe("later source\n");
}, 30_000);

it("keeps the old destination validation response compatible without claiming the live source is current", async () => {
  const offer = await prepare();
  await FSP.writeFile(Path.join(folder, "README.md"), "later source\n");
  const response = await fetch(`${served.url}${FOLDER_TRANSFER_PREFIX}/${id}/validate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${offer.token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(200);
  const approval = (await response.json()) as { current: boolean; captured: boolean };
  expect(approval).toEqual({ current: true, captured: true });
  expect((await sources.checkScan(id))?.freshness?.current).toBe(false);
}, 30_000);

it("omits suffixed env files from the real manifest and requires explicit per-file approval", async () => {
  await prepare();
  const loaded = await sources.read(id);
  const manifest = await readManifestFile(
    Path.join(state, "folder-sources", id, "manifest.ndjson.gz"),
  );
  expect(manifest.entries.some((entry) => entry.path === "scripts/.cf-monitor.env")).toBe(false);
  expect(loaded?.summary?.secretFiles.some((file) => file.path === "scripts/.cf-monitor.env")).toBe(
    true,
  );
  expect(loaded?.secrets).toBeUndefined();
  await sources.approveSecrets({
    operationId: id,
    paths: ["scripts/.cf-monitor.env"],
    destinationLabel: "synthetic destination",
  });
  expect((await sources.read(id))?.secrets?.files.map((file) => file.path)).toEqual([
    "scripts/.cf-monitor.env",
  ]);
});

it("refuses newly protected secret entries in a legacy preview even with an empty destination", async () => {
  await FSP.rm(Path.join(target, "README.md"));
  const offer = await prepare();
  const loaded = await sources.authorize(id, offer.token);
  const file = Path.join(state, "folder-sources", id, "manifest.ndjson.gz");
  const manifest = await readManifestFile(file);
  const bytes = Buffer.from("SYNTHETIC_ONLY=not-approved\n");
  const hash = Crypto.createHash("sha256").update(bytes).digest("hex");
  const legacyEntry = {
    path: "scripts/.cf-monitor.env",
    type: "file" as const,
    class: "untracked" as const,
    mode: 0o600,
    size: bytes.length,
    mtimeMs: 1,
    repo: ".",
    sha256: hash,
    chunks: [hash],
  };
  await writeManifest(file, { ...manifest, entries: [...manifest.entries, legacyEntry] });
  const { capturedSource: _captured, ...legacyRecord } = loaded.record;
  loaded.record = legacyRecord;
  loaded.entries = null;
  const approval = copies.approve(id);
  await expect(approval).rejects.toThrow(/newly protected secret-like file/);
  await expect(approval).rejects.toMatchObject({ detail: { recovery: "compare_again" } });
  expect(await FSP.readdir(target)).toEqual([]);
  await expect(sources.manifest(loaded)).rejects.toMatchObject({
    code: "secret_reapproval_required",
  });
  await expect(sources.chunks(loaded, [hash])).rejects.toMatchObject({
    code: "secret_reapproval_required",
  });
});
it("refuses corrupt captured backing before copying into an empty destination", async () => {
  await FSP.rm(Path.join(target, "README.md"));
  await prepare();
  await FSP.writeFile(
    Path.join(state, "folder-sources", id, "captured-files", "files.pack"),
    "corrupt",
  );
  await expect(copies.approve(id)).rejects.toThrow(/captured copy files/);
  expect(await FSP.readdir(target)).toEqual([]);
});
