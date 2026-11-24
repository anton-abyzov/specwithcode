// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - isolated captured-record integrity and crash-cleanup tests.
import * as Crypto from "node:crypto";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SELECTION } from "./classify.ts";
import * as Durable from "./durable.ts";
import { SourceTransfers } from "./sourceService.ts";
vi.mock("./durable.ts", async (original) => {
  const actual = await original<typeof Durable>();
  return { ...actual, writeJson: vi.fn(actual.writeJson) };
});

let base: string;
let folder: string;
let state: string;
let source: SourceTransfers;
let restarted: SourceTransfers | null;
let id: string;
beforeEach(async () => {
  base = await FSP.realpath(await FSP.mkdtemp(Path.join(OS.tmpdir(), "swc-capture-review-")));
  folder = Path.join(base, "source");
  state = Path.join(base, "state");
  await FSP.mkdir(folder);
  await FSP.writeFile(Path.join(folder, "a.txt"), "first source");
  source = new SourceTransfers(state, { stampClock: () => Date.now() + 10_000 });
  restarted = null;
  id = Crypto.randomUUID();
});
afterEach(async () => {
  vi.mocked(Durable.writeJson).mockReset();
  await source.close();
  await restarted?.close();
  await FSP.rm(base, { recursive: true, force: true });
});
const operationRoot = () => Path.join(state, "folder-sources", id);
async function ready() {
  const offer = await source.offer({
    operationId: id,
    folder,
    projectId: "fixture",
    mode: "copy-only",
    destinationEnvironmentId: "destination",
  });
  const loaded = await source.authorize(id, offer.token);
  await loaded.building;
  await source.requestManifest(loaded, DEFAULT_SELECTION);
  await loaded.building;
  expect(loaded.record.state).toBe("ready");
  expect(loaded.record.capturedSource).toBeDefined();
  return { loaded, token: offer.token };
}

it("refuses a captured job whose record lost capturedSource instead of reading live files", async () => {
  const { token } = await ready();
  await source.close();
  const file = Path.join(operationRoot(), "operation.json");
  const { capturedSource: _dropped, ...damaged } = JSON.parse(await FSP.readFile(file, "utf8"));
  await FSP.writeFile(file, JSON.stringify(damaged));
  restarted = new SourceTransfers(state, { stampClock: () => Date.now() + 10_000 });
  await expect(restarted.validateReviewed(id)).rejects.toMatchObject({
    code: "snapshot_unavailable",
  });
  const loaded = await restarted.authorize(id, token);
  await expect(restarted.manifest(loaded)).rejects.toMatchObject({
    code: "snapshot_unavailable",
  });
});

it("cleans the captured pack after a crash between the terminal save and cleanup", async () => {
  await ready();
  const actual = await vi.importActual<typeof Durable>("./durable.ts");
  vi.mocked(Durable.writeJson).mockImplementation(async (path, value) => {
    await actual.writeJson(path, value);
    // The process dies right after the end state reaches the disk.
    if ((value as { state?: string }).state === "cancelled") throw new Error("crashed");
  });
  await expect(source.cancel(id, "crash before cleanup")).rejects.toThrow("crashed");
  vi.mocked(Durable.writeJson).mockImplementation(actual.writeJson);
  await expect(FSP.stat(Path.join(operationRoot(), "captured-files"))).resolves.toBeDefined();
  restarted = new SourceTransfers(state);
  await restarted.sweepExpired();
  await expect(FSP.stat(Path.join(operationRoot(), "captured-files"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const record = await restarted.read(id);
  expect(record?.state).toBe("cancelled");
  expect(record?.snapshotCleanupPending).toBe(false);
});
