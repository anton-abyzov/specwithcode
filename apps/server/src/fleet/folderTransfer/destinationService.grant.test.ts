// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off - disposable real Git fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { DestinationCopies, type DestinationHooks } from "./destinationService.ts";
import { makeUmbrella, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import { SourceTransfers, type SourceOperationRecord } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";
import { TRANSFER_GRANT_IDLE_MS } from "./transferGrant.ts";

const HOUR = 60 * 60 * 1000;

let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
/** How far the source's clock runs ahead of the real one. */
let skew = 0;
const released: Array<string> = [];

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-grant-")));
  fixture = makeUmbrella(base);
  transfers = new SourceTransfers(NodePath.join(base, "source-state"), {
    now: () => Date.now() + skew,
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

/** A copy-and-move held after Apply because README.md changed on the source during the copy. */
async function heldCopy(copies: DestinationCopies, name: string) {
  skew = 0;
  const operationId = NodeCrypto.randomUUID();
  const target = NodePath.join(base, "targets", name);
  const offered = await transfers.offer({
    operationId,
    projectId: "project-source",
    folder: fixture.root,
    mode: "copy-and-move",
    destinationEnvironmentId: "env-destination",
  });
  await copies.start({
    operationId,
    sourceUrl: served.url,
    token: offered.token,
    sourceEnvironmentId: "env-source",
    sourceProjectId: "project-source",
    sourceMachine: "M4MAX",
    mode: "copy-and-move",
    targetFolder: target,
    title: "Umbrella",
  });
  await settle(copies, operationId, ["previewed", "failed"]);
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
      error: { code: "checks_failed" },
    });
  } finally {
    NodeFS.writeFileSync(readme, original);
  }
  return { operationId, target };
}

/** A fetch that holds the source commit until released. */
function heldCommit() {
  let entered!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher: NonNullable<DestinationHooks["fetch"]> = async (url, init) => {
    if (String(url).endsWith("/commit") && init?.method === "POST") {
      entered();
      await gate;
    }
    return fetch(url, init);
  };
  return { fetcher, holding, release };
}

describe("A held copy-and-move", () => {
  it("keeps its source grant alive past the idle limit, so Retry still commits", async () => {
    let registered = 0;
    const copies = new DestinationCopies(NodePath.join(base, "dest-keepalive"), {
      ...fast,
      keepaliveMs: 20,
      register: async () => {
        registered += 1;
        return "project-copied";
      },
    });
    try {
      const { operationId } = await heldCopy(copies, "keepalive");
      skew = TRANSFER_GRANT_IDLE_MS - HOUR;
      // The service's own keepalive calls the source for the held copy.
      await copies.resume();
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const grant = (await transfers.read(operationId))?.grant;
        if (grant && grant.lastUsedAt >= Date.now() + skew - 60_000) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Without that call the grant, last used before the jump, would have expired by now.
      skew = 2 * TRANSFER_GRANT_IDLE_MS - 2 * HOUR;
      await copies.retry(operationId);
      const finished = await settle(copies, operationId, ["applied", "failed"]);
      expect(finished).toMatchObject({
        state: "applied",
        committed: true,
        error: null,
        projectId: "project-copied",
      });
      expect(registered).toBe(1);
      expect((await transfers.read(operationId))?.state).toBe("committed");
    } finally {
      await copies.close();
    }
  }, 120_000);

  it("after its grant expired, says to cancel on the source, and Undo is not reported clean", async () => {
    const copies = new DestinationCopies(NodePath.join(base, "dest-expired"), {
      ...fast,
      register: async () => "project-copied",
    });
    try {
      const { operationId, target } = await heldCopy(copies, "expired");
      skew = TRANSFER_GRANT_IDLE_MS + HOUR;
      await copies.retry(operationId);
      const refused = await settle(copies, operationId, ["applied", "failed"]);
      expect(refused).toMatchObject({
        state: "failed",
        failedStep: "applied",
        committed: false,
        projectId: null,
        error: { code: "unauthorized" },
      });
      expect(refused.error?.message).toContain("cancel it on M4MAX to give the project back there");

      const undone = await copies.undo(operationId, true);
      expect(undone.result?.problems).toEqual([]);
      expect(NodeFS.existsSync(target)).toBe(false);
      expect(undone.record).toMatchObject({ state: "undone", error: { code: "unauthorized" } });
      expect(undone.record.error?.message).toContain(
        "Cancel the copy on M4MAX to give the project back there",
      );
      // The source still holds the copy, and cancelling it there gives the project back.
      expect((await transfers.read(operationId))?.state).toBe("ready");
      expect(released).not.toContain(operationId);
      const cancelled = await transfers.cancel(operationId, "Cancelled on the source.");
      expect(cancelled.state).toBe("cancelled");
      expect(released).toContain(operationId);
    } finally {
      await copies.close();
    }
  }, 120_000);

  it("refuses Undo while Retry is still committing", async () => {
    const held = heldCommit();
    let registered = 0;
    const copies = new DestinationCopies(NodePath.join(base, "dest-busy"), {
      ...fast,
      fetch: held.fetcher,
      register: async () => {
        registered += 1;
        return "project-copied";
      },
    });
    try {
      const { operationId, target } = await heldCopy(copies, "busy");
      await copies.retry(operationId);
      await held.holding;
      await expect(copies.undo(operationId, true)).rejects.toMatchObject({ code: "busy" });
      await expect(copies.retry(operationId)).rejects.toMatchObject({ code: "busy" });
      held.release();
      const finished = await settle(copies, operationId, ["applied", "failed"]);
      expect(finished).toMatchObject({ state: "applied", committed: true, error: null });
      expect(registered).toBe(1);
      expect(NodeFS.existsSync(NodePath.join(target, "README.md"))).toBe(true);
    } finally {
      held.release();
      await copies.close();
    }
  }, 120_000);

  it("closes promptly while a keepalive call waits on a silent source", async () => {
    let hang = false;
    let attempts = 0;
    const fetcher: NonNullable<DestinationHooks["fetch"]> = async (url, init) => {
      if (hang && String(url).endsWith("/hello")) {
        attempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      return fetch(url, init);
    };
    const copies = new DestinationCopies(NodePath.join(base, "dest-close"), {
      ...fast,
      fetch: fetcher,
      register: async () => "project-copied",
    });
    let closed = false;
    try {
      await heldCopy(copies, "close");
      hang = true;
      await copies.resume();
      for (let attempt = 0; attempt < 100 && attempts === 0; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(attempts).toBe(1);
      const outcome = await Promise.race([
        copies.close().then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 5_000)),
      ]);
      closed = outcome === "closed";
      expect(outcome).toBe("closed");
      // One attempt per tick: an offline source is not retried for minutes.
      expect(attempts).toBe(1);
    } finally {
      hang = false;
      if (!closed) await copies.close();
    }
  }, 120_000);

  it("finishes when the source committed but its reply was lost", async () => {
    let dropped = false;
    let registered = 0;
    const fetcher: NonNullable<DestinationHooks["fetch"]> = async (url, init) => {
      const response = await fetch(url, init);
      if (!dropped && String(url).endsWith("/commit") && init?.method === "POST") {
        dropped = true;
        throw new TypeError("fetch failed: socket hang up");
      }
      return response;
    };
    const copies = new DestinationCopies(NodePath.join(base, "dest-lost"), {
      ...fast,
      fetch: fetcher,
      register: async () => {
        registered += 1;
        return "project-copied";
      },
    });
    try {
      const { operationId } = await heldCopy(copies, "lost");
      await copies.retry(operationId);
      const finished = await settle(copies, operationId, ["applied", "failed"]);
      expect(dropped).toBe(true);
      expect(finished).toMatchObject({
        state: "applied",
        committed: true,
        error: null,
        projectId: "project-copied",
      });
      expect(registered).toBe(1);
      expect((await transfers.read(operationId))?.state).toBe("committed");
    } finally {
      await copies.close();
    }
  }, 120_000);

  it("refuses Undo and finishes when the source committed but every commit reply was lost", async () => {
    let dropping = true;
    let registered = 0;
    const fetcher: NonNullable<DestinationHooks["fetch"]> = async (url, init) => {
      const response = await fetch(url, init);
      if (dropping && String(url).endsWith("/commit") && init?.method === "POST")
        throw new TypeError("fetch failed: socket hang up");
      return response;
    };
    const copies = new DestinationCopies(NodePath.join(base, "dest-lost-undo"), {
      ...fast,
      fetch: fetcher,
      register: async () => {
        registered += 1;
        return "project-copied";
      },
    });
    try {
      const { operationId, target } = await heldCopy(copies, "lost-undo");
      await copies.retry(operationId);
      const lost = await settle(copies, operationId, ["applied", "failed"]);
      expect(lost).toMatchObject({
        state: "failed",
        failedStep: "applied",
        committed: false,
        error: { code: "unreachable" },
      });
      expect((await transfers.read(operationId))?.state).toBe("committed");
      dropping = false;
      await expect(copies.undo(operationId, true)).rejects.toMatchObject({
        code: "refused",
        message: expect.stringContaining("M4MAX had already finished this move"),
      });
      // Nothing was removed, and the copy finished here instead.
      expect(NodeFS.existsSync(NodePath.join(target, "README.md"))).toBe(true);
      const finished = await settle(copies, operationId, ["applied", "failed"]);
      expect(finished).toMatchObject({
        state: "applied",
        committed: true,
        error: null,
        projectId: "project-copied",
      });
      expect(registered).toBe(1);
    } finally {
      await copies.close();
    }
  }, 120_000);
});
