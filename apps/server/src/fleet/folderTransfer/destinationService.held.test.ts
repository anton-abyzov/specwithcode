// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - disposable real Git fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { DestinationCopies, type DestinationHooks } from "./destinationService.ts";
import { makeUmbrella, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import { SourceTransfers, type SourceOperationRecord } from "./sourceService.ts";
import { liveMovingCopies, serveSource } from "./sourceTestServer.testkit.ts";

let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
const released: Array<string> = [];

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-held-")));
  fixture = makeUmbrella(base);
  // Held copies come from live-file moves, which uncaptured volumes keep.
  transfers = new SourceTransfers(NodePath.join(base, "source-state"), {
    verifyCaptureFilesystem: liveMovingCopies,
    release: async (record: SourceOperationRecord) => {
      released.push(record.operationId);
    },
  });
  served = await serveSource(transfers, "env-source");
}, 60_000);
afterAll(async () => {
  if (served !== undefined) await served.close();
  NodeFS.rmSync(base, { recursive: true, force: true });
});

const fast = { allowLoopback: true, sleep: async () => undefined, pollMs: 20 } as const;

async function settle(
  copies: DestinationCopies,
  operationId: string,
  until: ReadonlyArray<string>,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await copies.waitFor(operationId);
    const record = await copies.read(operationId);
    if (record && until.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`copy ${operationId} never reached ${until.join(", ")}`);
}

const offerInput = (operationId: string, mode: "copy-only" | "copy-and-move") => ({
  operationId,
  projectId: "project-source",
  folder: fixture.root,
  mode,
  destinationEnvironmentId: "env-destination",
});

const startInput = (
  operationId: string,
  token: string,
  target: string,
  mode: "copy-only" | "copy-and-move" = "copy-only",
) => ({
  operationId,
  sourceUrl: served.url,
  token,
  sourceEnvironmentId: "env-source",
  sourceProjectId: "project-source",
  sourceMachine: "M4MAX",
  mode,
  targetFolder: target,
  title: "Umbrella",
});

/** A fetch that holds the first manifest poll until released (or its request is aborted). */
function heldManifest() {
  let entered!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  const fetcher: NonNullable<DestinationHooks["fetch"]> = async (url, init) => {
    if (!held && String(url).endsWith("/manifest") && init?.method === "GET") {
      held = true;
      entered();
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return fetch(url, init);
  };
  return { fetcher, holding, release };
}

describe("A re-offer during the comparison", () => {
  it("restarts a running comparison with the refreshed token", async () => {
    const held = heldManifest();
    const copies = new DestinationCopies(NodePath.join(base, "dest-restart"), {
      ...fast,
      fetch: held.fetcher,
    });
    const operationId = NodeCrypto.randomUUID();
    const target = NodePath.join(base, "targets", "restart");
    const first = await transfers.offer(offerInput(operationId, "copy-only"));
    try {
      await copies.start(startInput(operationId, first.token, target));
      await held.holding;
      // The source offers again while the destination compares: the first token stops working.
      const again = await transfers.offer(offerInput(operationId, "copy-only"));
      expect(again.token).not.toBe(first.token);
      await copies.start(startInput(operationId, again.token, target));
      const previewed = await settle(copies, operationId, ["previewed", "failed"]);
      expect(previewed).toMatchObject({ state: "previewed", error: null, token: again.token });
      expect((await copies.readPlan(operationId))?.rows.length).toBeGreaterThan(0);
    } finally {
      held.release();
      await copies.close();
    }
  }, 120_000);

  it("starts a comparison that failed on the revoked token again", async () => {
    const held = heldManifest();
    const copies = new DestinationCopies(NodePath.join(base, "dest-reset"), {
      ...fast,
      fetch: held.fetcher,
    });
    const operationId = NodeCrypto.randomUUID();
    const target = NodePath.join(base, "targets", "reset");
    const first = await transfers.offer(offerInput(operationId, "copy-only"));
    try {
      await copies.start(startInput(operationId, first.token, target));
      await held.holding;
      const again = await transfers.offer(offerInput(operationId, "copy-only"));
      // The held poll goes on with the old token and is refused.
      held.release();
      const failed = await settle(copies, operationId, ["failed", "previewed"]);
      expect(failed).toMatchObject({ state: "failed", failedStep: "scanning" });
      // The same token changes nothing; the new one starts the comparison over.
      expect((await copies.start(startInput(operationId, first.token, target))).state).toBe(
        "failed",
      );
      const restarted = await copies.start(startInput(operationId, again.token, target));
      expect(restarted).toMatchObject({ state: "planned", error: null, failedStep: null });
      const previewed = await settle(copies, operationId, ["previewed", "failed"]);
      expect(previewed).toMatchObject({ state: "previewed", error: null, token: again.token });
    } finally {
      held.release();
      await copies.close();
    }
  }, 120_000);
});

describe("A copy-and-move whose checks fail", () => {
  it("is held when Apply restored a file the source changed, names it, and Undo gives the source back", async () => {
    let registered = 0;
    const copies = new DestinationCopies(NodePath.join(base, "dest-held"), {
      ...fast,
      register: async () => {
        registered += 1;
        return "project-copied";
      },
    });
    const operationId = NodeCrypto.randomUUID();
    const target = NodePath.join(base, "targets", "held");
    const offered = await transfers.offer(offerInput(operationId, "copy-and-move"));
    await copies.start(startInput(operationId, offered.token, target, "copy-and-move"));
    await settle(copies, operationId, ["previewed", "failed"]);
    // A tracked file changes on the source after the comparison, while the copy runs.
    const readme = NodePath.join(fixture.root, "README.md");
    const original = NodeFS.readFileSync(readme);
    // Change after the approval freshness check, exercising the existing during-transfer recovery.
    const checkScan = transfers.checkScan.bind(transfers);
    const check = vi.spyOn(transfers, "checkScan");
    check.mockImplementationOnce(async (id) => {
      const result = await checkScan(id);
      check.mockRestore();
      NodeFS.writeFileSync(readme, "# Umbrella, changed during the copy\n");
      return result;
    });
    try {
      await copies.approve(operationId);
      const held = await settle(copies, operationId, ["applied", "failed"]);
      expect(held).toMatchObject({
        state: "failed",
        failedStep: "applied",
        committed: false,
        projectId: null,
        error: { code: "checks_failed" },
      });
      // Apply put README.md back to the snapshot, so the repository matches but is older.
      expect(NodeFS.readFileSync(NodePath.join(target, "README.md"))).toEqual(original);
      expect(held.checks.find((check) => check.repo === ".")).toMatchObject({ ok: true });
      expect(held.error?.message).toBe(
        "The files are in place, but 1 file was committed or edited on the source after copying started and is here as it was then (README.md); the source has newer work there that would not travel, so the coordinator stayed on the source. Copy again to bring that work, or Move anyway to move without it.",
      );
      expect(registered).toBe(0);
      expect((await transfers.read(operationId))?.state).not.toBe("committed");
      // Cancelling would drop Undo while the files stay; only Undo is offered.
      await expect(copies.cancel(operationId, "no")).rejects.toMatchObject({ code: "refused" });
      const undone = await copies.undo(operationId, true);
      expect(undone.result?.problems).toEqual([]);
      expect(NodeFS.existsSync(target)).toBe(false);
      expect((await transfers.read(operationId))?.state).toBe("released");
      expect(released).toContain(operationId);
    } finally {
      NodeFS.writeFileSync(readme, original);
      await copies.close();
    }
  }, 120_000);

  it("is held without commit or move when a repository check fails", async () => {
    let registered = 0;
    const copies = new DestinationCopies(NodePath.join(base, "dest-held-check"), {
      ...fast,
      register: async () => {
        registered += 1;
        return "project-copied";
      },
    });
    const operationId = NodeCrypto.randomUUID();
    const target = NodePath.join(base, "targets", "held-check");
    // A file only this machine has stays in the folder and shows in its git status.
    NodeFS.mkdirSync(target, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(target, "only-here.txt"), "destination only\n");
    const offered = await transfers.offer(offerInput(operationId, "copy-and-move"));
    await copies.start(startInput(operationId, offered.token, target, "copy-and-move"));
    expect(await settle(copies, operationId, ["previewed", "failed"])).toMatchObject({
      state: "previewed",
    });
    try {
      await copies.approve(operationId);
      const held = await settle(copies, operationId, ["applied", "failed"]);
      expect(held).toMatchObject({
        state: "failed",
        failedStep: "applied",
        committed: false,
        projectId: null,
        error: { code: "checks_failed" },
      });
      expect(held.error?.message).toBe(
        "The files are in place, but 1 repository differs from the source (the root), so the coordinator stayed on the source. Undo the copy, or retry to move it anyway.",
      );
      expect(held.checks.find((check) => check.repo === ".")?.problems).toContain(
        "git status differs from the source.",
      );
      expect(registered).toBe(0);
      expect((await transfers.read(operationId))?.state).toBe("ready");
      const undone = await copies.undo(operationId, true);
      expect(undone.result?.problems).toEqual([]);
      expect(NodeFS.readFileSync(NodePath.join(target, "only-here.txt"), "utf8")).toBe(
        "destination only\n",
      );
      expect((await transfers.read(operationId))?.state).toBe("released");
    } finally {
      await copies.close();
    }
  }, 120_000);

  it("a copy-only copy with the same change still commits", async () => {
    const copies = new DestinationCopies(NodePath.join(base, "dest-copy-only"), {
      ...fast,
      register: async () => "project-copied",
    });
    const operationId = NodeCrypto.randomUUID();
    const target = NodePath.join(base, "targets", "copy-only");
    const offered = await transfers.offer(offerInput(operationId, "copy-only"));
    await copies.start(startInput(operationId, offered.token, target));
    await settle(copies, operationId, ["previewed", "failed"]);
    const readme = NodePath.join(fixture.root, "README.md");
    const original = NodeFS.readFileSync(readme);
    // Change after the approval freshness check, exercising the existing during-transfer recovery.
    const validateReviewed = transfers.validateReviewed.bind(transfers);
    const check = vi.spyOn(transfers, "validateReviewed");
    check.mockImplementationOnce(async (id) => {
      const result = await validateReviewed(id);
      check.mockRestore();
      NodeFS.writeFileSync(readme, "# Umbrella, changed during the copy\n");
      return result;
    });
    try {
      await copies.approve(operationId);
      const applied = await settle(copies, operationId, ["applied", "failed"]);
      expect(applied).toMatchObject({ state: "applied", committed: true, error: null });
    } finally {
      NodeFS.writeFileSync(readme, original);
      await copies.close();
    }
  }, 120_000);
});
