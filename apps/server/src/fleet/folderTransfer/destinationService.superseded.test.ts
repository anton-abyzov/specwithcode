// @effect-diagnostics nodeBuiltinImport:off - disposable state folders only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import { DestinationCopies } from "./destinationService.ts";

let root: string;

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-superseded-"));
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

const OLD = "11111111-1111-4111-8111-111111111111";
const FINISHED = "22222222-2222-4222-8222-222222222222";
const NEWER = "33333333-3333-4333-8333-333333333333";
const ELSEWHERE = "44444444-4444-4444-8444-444444444444";

function write(operationId: string, patch: Record<string, unknown>) {
  const folder = NodePath.join(root, "folder-copies", operationId);
  NodeFS.mkdirSync(folder, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(folder, "operation.json"),
    JSON.stringify({
      version: 1,
      operationId,
      sourceEnvironmentId: "env-source",
      sourceProjectId: "project-source",
      sourceUrl: "http://127.0.0.1:9",
      sourceMachine: "m4",
      token: "test-grant",
      mode: "copy-only",
      targetFolder: "/home/anton/umb",
      title: "specweave",
      selection: [],
      decisions: {},
      clone: [],
      mirror: false,
      state: "previewed",
      failedStep: null,
      error: null,
      progress: null,
      checks: [],
      warnings: [],
      unstable: [],
      committed: false,
      projectId: null,
      createdAt: "2026-10-29T22:23:00.000Z",
      updatedAt: "2026-10-29T22:30:00.000Z",
      ...patch,
    }),
  );
}

const copies = () =>
  new DestinationCopies(root, {
    allowLoopback: true,
    sleep: async () => undefined,
    fetch: (async () => {
      throw new Error("the source is off");
    }) as never,
  });

it("closes a comparison a later finished copy made out of date, and nothing else", async () => {
  write(OLD, {});
  write(FINISHED, {
    state: "applied",
    committed: true,
    projectId: "project-there",
    createdAt: "2026-10-29T23:58:00.000Z",
    updatedAt: "2026-10-30T03:46:00.000Z",
  });
  write(NEWER, { updatedAt: "2026-10-31T10:00:00.000Z" });
  write(ELSEWHERE, { targetFolder: "/home/anton/other" });
  const service = copies();
  expect(await service.closeSupersededPreviews()).toEqual([OLD]);
  expect((await service.read(OLD))?.state).toBe("cancelled");
  expect((await service.read(FINISHED))?.state).toBe("applied");
  // Started after the finished copy, or for another folder: still waits for the person.
  expect((await service.read(NEWER))?.state).toBe("previewed");
  expect((await service.read(ELSEWHERE))?.state).toBe("previewed");
});

it("keeps a comparison while the later copy has not finished", async () => {
  write(OLD, {});
  write(FINISHED, {
    state: "applied",
    committed: false,
    createdAt: "2026-10-29T23:58:00.000Z",
    updatedAt: "2026-10-30T03:46:00.000Z",
  });
  const service = copies();
  expect(await service.closeSupersededPreviews()).toEqual([]);
  expect((await service.read(OLD))?.state).toBe("previewed");
});

it("keeps a comparison started after the copy, even when expired backups touch that copy later", async () => {
  write(OLD, {});
  write(FINISHED, {
    state: "applied",
    committed: true,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  });
  expect(await copies().closeSupersededPreviews()).toEqual([]);
});

it("keeps a waiting move when only a files-only copy finished", async () => {
  write(OLD, { mode: "copy-and-move" });
  write(FINISHED, {
    state: "applied",
    committed: true,
    mode: "copy-only",
    createdAt: "2026-10-29T23:58:00.000Z",
    updatedAt: "2026-10-30T03:46:00.000Z",
  });
  expect(await copies().closeSupersededPreviews()).toEqual([]);
});
