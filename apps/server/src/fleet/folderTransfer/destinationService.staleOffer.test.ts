// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off - disposable real Git fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { folderCopyError } from "../FolderCopyHandoff.ts";
import { CopyError, DestinationCopies } from "./destinationService.ts";
import { makeUmbrella, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import { SourceClientError } from "./sourceClient.ts";
import { SourceTransfers } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";

let base: string;
let stateRoot: string;
let fixture: UmbrellaFixture;
/** The source service the test server answers with; swapped to model a restart. */
let live: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-stale-")));
  fixture = makeUmbrella(base);
  stateRoot = NodePath.join(base, "source-state");
  live = new SourceTransfers(stateRoot);
  const current = new Proxy({} as SourceTransfers, {
    get: (_target, key) => {
      const value = Reflect.get(live, key);
      return typeof value === "function" ? value.bind(live) : value;
    },
  });
  served = await serveSource(current, "env-source");
}, 60_000);
afterAll(async () => {
  if (served !== undefined) await served.close();
  NodeFS.rmSync(base, { recursive: true, force: true });
});

const fast = { allowLoopback: true, sleep: async () => undefined, pollMs: 20 } as const;

async function previewed(copies: DestinationCopies, name: string) {
  const operationId = NodeCrypto.randomUUID();
  const offered = await live.offer({
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
    targetFolder: NodePath.join(base, "targets", name),
    title: "Umbrella",
  });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await copies.waitFor(operationId);
    const record = await copies.read(operationId);
    if (record?.state === "previewed") return operationId;
    if (record?.state === "failed") throw new Error(record.error?.message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the copy never reached its preview");
}

describe("A reviewed copy whose source offer is gone", () => {
  it("refuses Approve with a message that names the source and says to start again", async () => {
    const copies = new DestinationCopies(NodePath.join(base, "dest-removed"), fast);
    try {
      const operationId = await previewed(copies, "removed");
      // A disk cleanup moved the source's saved offers away, and the app restarted.
      await live.close();
      NodeFS.rmSync(NodePath.join(stateRoot, "folder-sources", operationId), {
        recursive: true,
        force: true,
      });
      live = new SourceTransfers(stateRoot);

      const refusal = await copies.approve(operationId).catch((cause: unknown) => cause);
      expect(refusal).toBeInstanceOf(CopyError);
      expect((refusal as CopyError).code).toBe("unauthorized");
      expect((refusal as CopyError).message).toContain("M4MAX no longer accepts this move");
      expect((refusal as CopyError).message).toContain("Start the move again from M4MAX");

      const wire = folderCopyError(refusal);
      expect(wire.code).toBe("unauthorized");
      expect(wire.message).not.toContain("The copy failed. unauthorized");
      expect(wire.message).toContain("M4MAX no longer accepts this move");
      // Nothing was copied, and the copy stays reviewable so Cancel can end it.
      expect((await copies.read(operationId))?.state).toBe("previewed");
    } finally {
      await copies.close();
    }
  }, 120_000);

  it("maps a source refusal that escaped unmapped to its own wire code", () => {
    const wire = folderCopyError(new SourceClientError("unauthorized", 401));
    expect(wire.code).toBe("unauthorized");
    expect(wire.message).not.toBe("The copy failed. unauthorized");
  });
});
