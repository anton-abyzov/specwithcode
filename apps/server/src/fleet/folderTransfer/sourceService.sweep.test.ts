// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable state folders for the expiry sweep.
import * as Crypto from "node:crypto";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SELECTION } from "./classify.ts";
import * as Capture from "./sourceSnapshot.ts";
import { SourceTransfers } from "./sourceService.ts";
import { TRANSFER_GRANT_IDLE_MS } from "./transferGrant.ts";

vi.mock("./sourceSnapshot.ts", async (original) => {
  const actual = await original<typeof Capture>();
  return { ...actual, captureSourceFiles: vi.fn(actual.captureSourceFiles) };
});

let base: string;
let folder: string;
let state: string;
let clock: number;
const services: Array<SourceTransfers> = [];
const service = () => {
  const made = new SourceTransfers(state, {
    now: () => clock,
    stampClock: () => Date.now() + 10_000,
  });
  services.push(made);
  return made;
};
beforeEach(async () => {
  base = await FSP.realpath(await FSP.mkdtemp(Path.join(OS.tmpdir(), "swc-source-sweep-")));
  folder = Path.join(base, "source");
  state = Path.join(base, "state");
  await FSP.mkdir(folder);
  await FSP.writeFile(Path.join(folder, "a.txt"), "first source");
  clock = 1_000_000;
});
afterEach(async () => {
  vi.mocked(Capture.captureSourceFiles).mockReset();
  for (const made of services.splice(0)) await made.close();
  await FSP.rm(base, { recursive: true, force: true });
});

const operationRoot = (id: string) => Path.join(state, "folder-sources", id);
const exists = (path: string) =>
  FSP.stat(path).then(
    () => true,
    () => false,
  );
async function ready(source: SourceTransfers) {
  const id = Crypto.randomUUID();
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
  expect(await exists(Path.join(operationRoot(id), "captured-files"))).toBe(true);
  return id;
}

it("cancels an expired ready copy after a restart and removes its snapshot, keeping an unexpired one", async () => {
  const first = service();
  const expired = await ready(first);
  clock += TRANSFER_GRANT_IDLE_MS - 60_000;
  const fresh = await ready(first);
  await first.close();
  clock += 120_000;

  const restarted = service();
  await expect(restarted.sweepExpired()).resolves.toEqual([expired]);
  const record = await restarted.read(expired);
  expect(record).toMatchObject({ state: "cancelled" });
  expect(record?.grant.revokedAt).toBe(clock);
  expect(await exists(Path.join(operationRoot(expired), "captured-files"))).toBe(false);
  expect(await exists(Path.join(operationRoot(expired), "portable-git"))).toBe(false);
  expect(await exists(Path.join(operationRoot(expired), "operation.json"))).toBe(true);

  expect(await restarted.read(fresh)).toMatchObject({ state: "ready" });
  expect(await exists(Path.join(operationRoot(fresh), "captured-files"))).toBe(true);
  // A second sweep finds nothing left to end.
  await expect(restarted.sweepExpired()).resolves.toEqual([]);
});

it("cancels an expired copy still cached in memory", async () => {
  const source = service();
  const id = await ready(source);
  clock += TRANSFER_GRANT_IDLE_MS;
  await expect(source.sweepExpired()).resolves.toEqual([id]);
  expect(await source.read(id)).toMatchObject({ state: "cancelled" });
  expect(await exists(Path.join(operationRoot(id), "captured-files"))).toBe(false);
});

it("leaves a copy that is still building, and ignores folders that are not operations", async () => {
  const source = service();
  const actual = await vi.importActual<typeof Capture>("./sourceSnapshot.ts");
  let unblock!: () => void;
  const stuck = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  vi.mocked(Capture.captureSourceFiles).mockImplementation(async (input) => {
    await stuck;
    return actual.captureSourceFiles(input);
  });
  const id = Crypto.randomUUID();
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
  expect(loaded.record.state).toBe("building");
  await FSP.mkdir(Path.join(state, "folder-sources", "not-an-operation"));
  clock += TRANSFER_GRANT_IDLE_MS * 2;
  try {
    await expect(source.sweepExpired()).resolves.toEqual([]);
    expect(loaded.record.state).toBe("building");
    expect(loaded.record.grant.revokedAt).toBeNull();
    expect(await exists(Path.join(state, "folder-sources", "not-an-operation"))).toBe(true);
  } finally {
    unblock();
    await loaded.building;
  }
});

it("never throws when the state folder is missing", async () => {
  await expect(service().sweepExpired()).resolves.toEqual([]);
});
