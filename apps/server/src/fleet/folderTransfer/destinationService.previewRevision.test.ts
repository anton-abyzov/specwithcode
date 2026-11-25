// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - disposable real Git fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { copyStatus } from "../FolderCopyHandoff.ts";
import { CopyError, DestinationCopies } from "./destinationService.ts";
import { makeUmbrella, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import { SourceTransfers } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";

let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-revision-")));
  fixture = makeUmbrella(base);
  transfers = new SourceTransfers(NodePath.join(base, "source-state"));
  served = await serveSource(transfers, "env-source");
}, 60_000);
afterAll(async () => {
  if (served !== undefined) await served.close();
  await transfers?.close();
  NodeFS.rmSync(base, { recursive: true, force: true });
});

let free = Number.MAX_SAFE_INTEGER;
const fast = {
  allowLoopback: true,
  sleep: async () => undefined,
  pollMs: 20,
  freeBytes: async () => free,
} as const;

async function settle(copies: DestinationCopies, operationId: string, until: string) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await copies.waitFor(operationId);
    const record = await copies.read(operationId);
    if (record?.state === until || record?.state === "failed") return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`copy ${operationId} never reached ${until}`);
}

async function previewed(name: string, freeBytes?: () => Promise<number>) {
  const operationId = NodeCrypto.randomUUID();
  const offered = await transfers.offer({
    operationId,
    projectId: "project-source",
    folder: fixture.root,
    mode: "copy-only",
    destinationEnvironmentId: "env-destination",
  });
  const copies = new DestinationCopies(NodePath.join(base, `dest-${name}`), {
    ...fast,
    ...(freeBytes ? { freeBytes } : {}),
  });
  await copies.start({
    operationId,
    sourceUrl: served.url,
    token: offered.token,
    sourceEnvironmentId: "env-source",
    sourceProjectId: "project-source",
    sourceMachine: "M4MAX",
    mode: "copy-only",
    targetFolder: NodePath.join(base, "targets", name),
    title: "Umbrella",
  });
  const record = await settle(copies, operationId, "previewed");
  expect(record?.state).toBe("previewed");
  const status = copyStatus(record!, await copies.readPlan(operationId));
  return { copies, operationId, status };
}

it("refuses an approval for a preview the window did not see", async () => {
  const { copies, operationId, status } = await previewed("unseen");
  const seen = status.previewRevision;
  expect(seen).toMatch(/^[a-f0-9]{64}$/);
  // Another window changes a choice and the comparison finishes again.
  await copies.decide(operationId, { mirror: !status.mirror });
  const changed = await settle(copies, operationId, "previewed");
  const now = copyStatus(changed!, await copies.readPlan(operationId)).previewRevision;
  expect(now).not.toBe(seen);
  const refused = await copies
    .approve(operationId, { previewRevision: seen! })
    .catch((cause: unknown) => cause);
  expect(refused).toBeInstanceOf(CopyError);
  expect((refused as CopyError).code).toBe("refused");
  expect((await copies.read(operationId))?.state).toBe("previewed");
  // The revision of the preview now shown approves.
  expect((await copies.approve(operationId, { previewRevision: now! })).state).toBe("approved");
}, 120_000);

it("names no revision once the copy left the preview", async () => {
  const { copies, operationId, status } = await previewed("approved");
  const approved = await copies.approve(operationId, { previewRevision: status.previewRevision! });
  expect(copyStatus(approved, await copies.readPlan(operationId)).previewRevision).toBeUndefined();
}, 120_000);

it("clears a disk shortage when the comparison is recomputed with room", async () => {
  const { copies, operationId } = await previewed("disk");
  free = 1;
  const refused = await copies.approve(operationId).catch((cause: unknown) => cause);
  expect((refused as CopyError).code).toBe("disk_space");
  expect((await copies.read(operationId))?.disk).not.toBeNull();
  free = Number.MAX_SAFE_INTEGER;
  await copies.decide(operationId, {});
  const recomputed = await settle(copies, operationId, "previewed");
  expect(recomputed?.disk).toBeNull();
}, 120_000);

it("clears the disk shortage when approving finds a changed destination", async () => {
  const { copies, operationId } = await previewed("disk-recheck");
  free = 1;
  await copies.approve(operationId).catch(() => undefined);
  expect((await copies.read(operationId))?.disk).not.toBeNull();
  free = Number.MAX_SAFE_INTEGER;
  // The destination gains work meanwhile, so approving compares again before measuring.
  const target = NodePath.join(base, "targets", "disk-recheck");
  NodeFS.mkdirSync(target, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(target, "README.md"), "work that appeared here");
  const refused = await copies.approve(operationId).catch((cause: unknown) => cause);
  expect((refused as CopyError).message).toMatch(/destination changed/);
  expect((await copies.read(operationId))?.disk).toBeNull();
}, 120_000);

it("never puts a shortage measured for an older preview on a newer one", async () => {
  let change: (() => Promise<void>) | null = null;
  const { copies, operationId, status } = await previewed("disk-late", async () => {
    // Another window changes a choice and its comparison finishes while space is measured.
    const run = change;
    change = null;
    await run?.();
    return 1;
  });
  change = async () => {
    await copies.decide(operationId, { mirror: !status.mirror });
    await settle(copies, operationId, "previewed");
  };
  const refused = await copies.approve(operationId).catch((cause: unknown) => cause);
  expect(refused).toBeInstanceOf(CopyError);
  const after = await copies.read(operationId);
  expect(after?.mirror).toBe(!status.mirror);
  expect(after?.disk).toBeNull();
}, 120_000);

it("names the destination contents a preview saw, and a new name once they change", async () => {
  const { copies, operationId, status } = await previewed("contents");
  const seen = status.destinationRevision;
  expect(seen).toMatch(/^[a-f0-9]{64}$/);
  // Choices alone leave the destination's name as it was.
  await copies.decide(operationId, { mirror: !status.mirror });
  const chosen = await settle(copies, operationId, "previewed");
  expect(copyStatus(chosen!, await copies.readPlan(operationId)).destinationRevision).toBe(seen);
  // Something written there before the next comparison gives it a new one.
  const target = NodePath.join(base, "targets", "contents");
  NodeFS.mkdirSync(target, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(target, "README.md"), "edited here");
  await copies.decide(operationId, { mirror: status.mirror });
  const edited = await settle(copies, operationId, "previewed");
  const now = copyStatus(edited!, await copies.readPlan(operationId)).destinationRevision;
  expect(now).toMatch(/^[a-f0-9]{64}$/);
  expect(now).not.toBe(seen);
}, 120_000);
