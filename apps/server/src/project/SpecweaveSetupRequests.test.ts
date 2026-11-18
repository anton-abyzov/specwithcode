// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  isOpenRequest,
  openSetupRequest,
  readProjectFacts,
  recordDeclined,
  recordSetupSuccess,
  setRequestState,
  specweaveSetupFile,
} from "./SpecweaveSetupRequests.ts";

const roots: string[] = [];
async function stateFile() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "specweave-requests-"));
  roots.push(root);
  return specweaveSetupFile(root);
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("SpecweaveSetupRequests (1396 AC-05, AC-07)", () => {
  it("keeps one open card per project: a second request returns the open one", async () => {
    const file = await stateFile();
    const first = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "thread-a",
      gitRepository: false,
    });
    expect(first.created).toBe(true);
    expect(first.request).toMatchObject({
      threadId: "thread-a",
      state: "asking",
      gitRepository: false,
    });
    const second = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "thread-b",
      gitRepository: true,
    });
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
    expect(second.request.threadId).toBe("thread-a");
    // Another project gets its own card.
    const other = await openSetupRequest(file, {
      projectId: "p2",
      threadId: "thread-c",
      gitRepository: true,
    });
    expect(other.created).toBe(true);
  });

  it("moves a card through its states, stays answerable after a failure, and opens a new one once settled", async () => {
    const file = await stateFile();
    const { request } = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "t",
      gitRepository: true,
    });
    const failed = await setRequestState(file, {
      projectId: "p1",
      requestId: request.requestId,
      state: "failed",
      detail: "specweave init exited with 1.",
    });
    expect(failed).toMatchObject({ state: "failed", detail: "specweave init exited with 1." });
    expect(isOpenRequest(failed ?? undefined)).toBe(true);
    const on = await setRequestState(file, {
      projectId: "p1",
      requestId: request.requestId,
      state: "on",
    });
    expect(on?.state).toBe("on");
    expect(on?.detail).toBeUndefined();
    expect(isOpenRequest(on ?? undefined)).toBe(false);
    // A stale request id moves nothing.
    expect(
      await setRequestState(file, { projectId: "p1", requestId: "stale", state: "declined" }),
    ).toBeNull();
    const next = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "t2",
      gitRepository: true,
    });
    expect(next.created).toBe(true);
  });

  it("stores the decline until a successful setup clears it", async () => {
    const file = await stateFile();
    expect(await readProjectFacts(file, "p1")).toEqual({});
    await recordDeclined(file, "p1");
    expect((await readProjectFacts(file, "p1")).declined).toBe(true);
    await recordSetupSuccess(file, "p1");
    expect(await readProjectFacts(file, "p1")).toEqual({});
  });

  it("serializes concurrent writes so none is lost", async () => {
    const file = await stateFile();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => recordDeclined(file, `p${String(index)}`)),
    );
    for (let index = 0; index < 12; index += 1) {
      expect((await readProjectFacts(file, `p${String(index)}`)).declined).toBe(true);
    }
  });

  it("reads a missing or broken file as empty", async () => {
    const file = await stateFile();
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, "{not json");
    expect(await readProjectFacts(file, "p1")).toEqual({});
    await recordDeclined(file, "p1");
    expect((await readProjectFacts(file, "p1")).declined).toBe(true);
  });
});
