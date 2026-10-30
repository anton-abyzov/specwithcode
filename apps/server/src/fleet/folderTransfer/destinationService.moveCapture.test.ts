// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - isolated actual source/destination HTTP move regressions.
import * as Crypto from "node:crypto";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as EffectPath from "effect/Path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import {
  folderCopyAllConflictsKey,
  type MachineHandoffManifest,
  type ProjectId,
} from "@specweave-studio/contracts";
import { makeAppliedFolderCopyCheck } from "../folderCopyPreparation.ts";
import { DestinationCopies, type DestinationRecord } from "./destinationService.ts";
import { git } from "./folderFixture.testkit.ts";
import { SourceTransfers } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";

const LEDGER = ".specweave/increments/0001-move/ledger.jsonl";
const METADATA = ".specweave/increments/0001-move/metadata.json";

let base: string;
let folder: string;
let target: string;
let sources: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
let copies: DestinationCopies;
beforeEach(async () => {
  base = await FSP.realpath(await FSP.mkdtemp(Path.join(OS.tmpdir(), "swc-move-capture-")));
  folder = Path.join(base, "source");
  target = Path.join(base, "destination");
  await FSP.mkdir(Path.join(folder, ".specweave/increments/0001-move"), { recursive: true });
  await FSP.writeFile(Path.join(folder, "README.md"), "moving project\n");
  await FSP.writeFile(Path.join(folder, LEDGER), '{"t":"T-01","e":"claim"}\n');
  await FSP.writeFile(Path.join(folder, METADATA), '{"status":"active"}\n');
  git(folder, "init", "-q");
  git(folder, "add", "README.md");
  git(folder, "commit", "-qm", "initial");
  sources = new SourceTransfers(Path.join(base, "source-state"));
  served = await serveSource(sources, "source-env");
  copies = new DestinationCopies(Path.join(base, "destination-state"), {
    allowLoopback: true,
    pollMs: 1,
    sleep: async () => {},
    register: async () => "project-copied",
  });
});
afterEach(async () => {
  await copies?.close();
  await sources?.close();
  await served?.close();
  await FSP.rm(base, { recursive: true, force: true });
});

async function settle(id: string, states: ReadonlyArray<string>): Promise<DestinationRecord> {
  for (let i = 0; i < 600; i++) {
    await copies.waitFor(id);
    const record = await copies.read(id);
    if (record && states.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Copy did not settle");
}

async function preview(mode: "copy-only" | "copy-and-move") {
  const id = Crypto.randomUUID();
  const offer = await sources.offer({
    operationId: id,
    projectId: "source-project",
    folder,
    mode,
    destinationEnvironmentId: "destination-env",
  });
  await copies.start({
    operationId: id,
    sourceUrl: served.url,
    token: offer.token,
    sourceEnvironmentId: "source-env",
    sourceProjectId: "source-project",
    sourceMachine: "Source",
    mode,
    targetFolder: target,
    title: "Moving project",
  });
  const initial = await settle(id, ["previewed", "failed"]);
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
  expect((await settle(id, ["previewed", "failed"])).state).toBe("previewed");
  return id;
}

it("moves into a folder that already holds the project while its ledger keeps changing", async () => {
  const first = await preview("copy-only");
  await copies.approve(first);
  expect((await settle(first, ["applied", "failed"])).state).toBe("applied");
  expect(await FSP.readFile(Path.join(target, LEDGER), "utf8")).toBe('{"t":"T-01","e":"claim"}\n');

  await FSP.appendFile(Path.join(folder, LEDGER), '{"t":"T-01","e":"done"}\n');
  const id = await preview("copy-and-move");
  const record = await sources.read(id);
  expect(record?.capturedSource?.version).toBe(1);
  const capturedLedger = await FSP.readFile(Path.join(folder, LEDGER), "utf8");
  // A live project: the ledger and metadata change after the preview was reviewed.
  await FSP.appendFile(Path.join(folder, LEDGER), '{"t":"T-02","e":"claim"}\n');
  await FSP.writeFile(Path.join(folder, METADATA), '{"status":"in-progress"}\n');

  const approved = await copies.approve(id);
  expect(approved.warnings.some((warning) => warning.startsWith("The source changed"))).toBe(false);
  const applied = await settle(id, ["applied", "failed"]);
  expect(applied.error).toBeNull();
  expect(applied).toMatchObject({ state: "applied", unstable: [], committed: true });
  expect(applied.checks.filter((check) => !check.ok)).toEqual([]);
  expect(await FSP.readFile(Path.join(target, LEDGER), "utf8")).toBe(capturedLedger);
  expect(await FSP.readFile(Path.join(target, METADATA), "utf8")).toBe('{"status":"active"}\n');
  expect((await sources.read(id))?.state).toBe("committed");

  const check = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* EffectPath.Path;
    yield* makeAppliedFolderCopyCheck(copies, fs, path)(
      id,
      "project-copied" as ProjectId,
      "source-env",
      target,
      {} as MachineHandoffManifest,
    );
  });
  await Effect.runPromise(check.pipe(Effect.provide(NodeServices.layer)));
}, 60_000);
