// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable state folders and a bounded close.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProjectId } from "@specweave-studio/contracts";
import * as Manifest from "./manifest.ts";
import { SourceTransfers } from "./sourceService.ts";

vi.mock("./manifest.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest.ts")>();
  return { ...actual, scanFolder: vi.fn(actual.scanFolder) };
});

const folders: Array<string> = [];
afterEach(() => {
  vi.mocked(Manifest.scanFolder).mockReset();
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});
const operationId = "00000000-0000-4000-8000-000000000992";

const tempState = () => {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-copy-close-stuck-")),
  );
  folders.push(base);
  const folder = NodePath.join(base, "project");
  NodeFS.mkdirSync(folder);
  NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "notes\n");
  return { folder, state: NodePath.join(base, "state") };
};
const readRecord = (state: string) =>
  JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(state, "folder-sources", operationId, "operation.json"),
      "utf8",
    ),
  );
/** Starts `cancel` and returns once it is queued in the operation's terminal chain. */
const queueCancel = async (sources: SourceTransfers, token: string) => {
  const loaded = await sources.authorize(operationId, token);
  const idle = loaded.terminalUpdate;
  const cancelling = sources.cancel(operationId, "stopped").then(
    (record) => record.state,
    (error: { code?: string }) => error.code ?? "rejected",
  );
  for (let attempt = 0; attempt < 400 && loaded.terminalUpdate === idle; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(loaded.terminalUpdate).not.toBe(idle);
  // Wrapped, so awaiting this helper does not also await the cancel.
  return { cancelling };
};

it("returns promptly from close while a cancel waits on a stuck scan, and persists only the cancel", async () => {
  const { folder, state } = tempState();
  const actual = await vi.importActual<typeof import("./manifest.ts")>("./manifest.ts");
  let unblock!: () => void;
  const stuck = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  vi.mocked(Manifest.scanFolder).mockImplementation(async (root) => {
    await stuck;
    return actual.scanFolder(root);
  });
  let clock = 1_000_000;
  const released: Array<string> = [];
  const sources = new SourceTransfers(state, {
    now: () => clock,
    release: async (record) => {
      released.push(record.operationId);
    },
  });
  const offered = await sources.offer({
    operationId,
    projectId: ProjectId.make("source-project"),
    folder,
    mode: "copy-and-move",
    destinationEnvironmentId: "destination",
  });
  // The cancel transition waits for the running scan inside the terminal chain.
  const { cancelling } = await queueCancel(sources, offered.token);
  const closed = await Promise.race([
    sources.close().then((pending) => ({ pending })),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1_500)),
  ]);
  // Waiting behind a scan is skipped, not a bound that fired.
  expect(closed).toEqual({ pending: [] });

  // A routine save after close (a grant refresh) stays in memory.
  const lastUsedAt = readRecord(state).grant.lastUsedAt;
  clock += 61_000;
  await sources.authorize(operationId, offered.token);
  expect(readRecord(state).grant.lastUsedAt).toBe(lastUsedAt);

  // The scan stops at close without recording a failure; the cancel that then
  // returns the coordinator must still record its end state and revoked grant.
  unblock();
  expect(await cancelling).toBe("cancelled");
  expect(released).toEqual([operationId]);
  const directory = NodePath.join(state, "folder-sources", operationId);
  expect(NodeFS.readdirSync(directory).sort()).toEqual(["operation.json"]);
  const persisted = readRecord(state);
  expect(persisted.state).toBe("cancelled");
  expect(persisted.grant.revokedAt).not.toBeNull();

  // A restarted source refuses to continue the cancelled copy.
  const restarted = new SourceTransfers(state, { now: () => clock });
  expect((await restarted.read(operationId))?.state).toBe("cancelled");
  await expect(restarted.authorize(operationId, offered.token)).rejects.toMatchObject({
    code: "unauthorized",
  });
  await expect(restarted.assertContextAvailable(operationId)).rejects.toMatchObject({
    code: "context_closed",
  });
  NodeFS.rmSync(state, { recursive: true });
  expect(NodeFS.existsSync(state)).toBe(false);
});

it("reports an operation whose transition outlives the close bound", async () => {
  const { folder, state } = tempState();
  let unblock!: () => void;
  const hookHeld = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const sources = new SourceTransfers(state, { release: () => hookHeld });
  const offered = await sources.offer({
    operationId,
    projectId: ProjectId.make("source-project"),
    folder,
    mode: "copy-and-move",
    destinationEnvironmentId: "destination",
  });
  // Wait for the scan itself to finish, not only its in-memory "scanned".
  const loaded = await sources.authorize(operationId, offered.token);
  for (let attempt = 0; attempt < 400 && loaded.building !== null; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(loaded.building).toBeNull();
  expect(loaded.record.state).toBe("scanned");
  // No scan is running, so close waits for the cancel, whose release hook never returns.
  const { cancelling } = await queueCancel(sources, offered.token);
  expect(await sources.close()).toEqual([{ operationId, pending: 1 }]);
  unblock();
  expect(await cancelling).toBe("cancelled");
  expect(readRecord(state).state).toBe("cancelled");
});
