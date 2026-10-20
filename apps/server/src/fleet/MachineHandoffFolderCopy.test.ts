// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable real folders and scan polling.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  EnvironmentId,
  ProjectId,
  type MachineHandoffBundle,
  type MachineHandoffPrepareInput,
} from "@specweave-studio/contracts";
import * as MachineHandoff from "./MachineHandoff.ts";
import * as MachineHandoffStore from "./MachineHandoffStore.ts";
import type { DestinationRecord } from "./folderTransfer/destinationService.ts";
import { validManifest } from "./handoffGitTypes.ts";
import {
  makeHarness,
  imported,
  preview,
  destinationPreview,
  id,
  projectId,
  threadId,
} from "./MachineHandoff.test-fixtures.ts";

const folders: Array<string> = [];
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});
const sourceFolder = () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-folder-copy-source-"));
  folders.push(folder);
  NodeFS.writeFileSync(NodePath.join(folder, "README.md"), "notes\n");
  NodeFS.writeFileSync(NodePath.join(folder, ".env"), "NOT_A_REAL_SECRET=1\n");
  return folder;
};
const tailnet = [
  { kind: "lan" as const, httpBaseUrl: "http://192.168.1.4:3773" },
  { kind: "tailnet" as const, httpBaseUrl: "https://source.example.ts.net" },
];
const failureOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return result.failure;
      throw new Error("Expected request to fail");
    }),
  );
const other = EnvironmentId.make("other-env");
const copyPreview = {
  ...preview,
  destination: {
    ...preview.destination,
    executionMode: "project-folder" as const,
    coordinatorThreadId: threadId,
    transport: "folder-copy" as const,
  },
} satisfies MachineHandoffPrepareInput;

const scanned = (service: MachineHandoff.MachineHandoff["Service"]) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = yield* service.copySourceStatus({ operationId: id });
      if (status.state !== "scanning") return status;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
    }
    throw new Error("The scan did not finish");
  });

/** The destination's bundle for a folder copy that continues in its own project folder. */
const folderCopyBundle = (prepared: MachineHandoffBundle) => {
  const importedBundle = imported(prepared);
  const { digest: _, ...value } = {
    ...importedBundle,
    destination: {
      ...importedBundle.destination!,
      executionMode: "project-folder" as const,
      transport: "folder-copy" as const,
    },
    coordinatorBinding: {
      ...importedBundle.coordinatorBinding!,
      successor: {
        environmentId: EnvironmentId.make("source-env"),
        projectId,
        coordinatorThreadId: threadId,
      },
    },
  };
  return { ...value, digest: MachineHandoff.machineHandoffDigest(value) };
};

it.live("refuses to offer a copy without a private HTTPS address", () => {
  const h = makeHarness({
    workspaceRoot: sourceFolder(),
    endpoints: [{ kind: "lan", httpBaseUrl: "http://192.168.1.4:3773" }],
  });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const error = yield* failureOnly(
      service.copyOffer({
        projectId,
        operationId: id,
        mode: "copy-only",
        destinationEnvironmentId: other,
      }),
    );
    expect(error.code).toBe("no_private_url");
  }).pipe(Effect.provide(h.layer));
});

it.live("offers a plain copy while chats run and never fences the coordinator", () => {
  const h = makeHarness({ workspaceRoot: sourceFolder(), endpoints: tailnet, busy: true });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const offer = yield* service.copyOffer({
      projectId,
      operationId: id,
      mode: "copy-only",
      destinationEnvironmentId: other,
    });
    expect(offer.sourceUrl).toBe("https://source.example.ts.net");
    expect(offer.sourceMachine).toBe("Source Mac");
    expect(offer.token.length).toBeGreaterThan(20);
    const status = yield* scanned(service);
    expect(status.state).toBe("scanned");
    expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding).toBeUndefined();
    expect(h.state.policyUpdates).toHaveLength(0);
  }).pipe(Effect.provide(h.layer));
});

it.live("refuses to move the coordinator while a chat in the folder is running", () => {
  const h = makeHarness({ workspaceRoot: sourceFolder(), endpoints: tailnet, busy: true });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const error = yield* failureOnly(
      service.copyOffer({
        projectId,
        operationId: id,
        mode: "copy-and-move",
        destinationEnvironmentId: other,
      }),
    );
    expect(error.code).toBe("busy");
  }).pipe(Effect.provide(h.layer));
});

it.live("fences a copy-and-move without Git publication and releases it with a reason", () => {
  const h = makeHarness({ workspaceRoot: sourceFolder(), endpoints: tailnet });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    // Without an offered scan there is nothing to describe.
    expect((yield* failureOnly(service.prepare(copyPreview))).code).toBe("invalid");
    yield* service.copyOffer({
      projectId,
      operationId: id,
      mode: "copy-and-move",
      destinationEnvironmentId: other,
    });
    yield* scanned(service);
    const prepared = yield* service.prepare(copyPreview);
    expect(validManifest(prepared.bundle.manifest)).toBe(true);
    expect(prepared.bundle.manifest.repositories[0]?.identity).toBe("folder-copy:root");
    expect(prepared.bundle.destination?.transport).toBe("folder-copy");
    const published = yield* service.prepare({
      ...copyPreview,
      publish: true,
      expectedDigest: prepared.bundle.digest,
    });
    expect(published.publication).toBe("published");
    expect(h.state.pushes).toBe(0);
    expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding?.state).toBe(
      "transferring",
    );
    const released = yield* service.copyRelease({
      projectId,
      operationId: id,
      reason: "The other machine refused the copy.",
    });
    expect(released.released).toBe(true);
    const binding = h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding;
    expect(binding?.state).toBe("active");
    expect(binding?.releaseReason).toBe("The other machine refused the copy.");
    expect(h.state.policyUpdates.at(-1)?.ownership?.releasedHandoffOperationId).toBe(id);
    expect((yield* service.copySourceStatus({ operationId: id })).state).toBe("cancelled");
    // A second release finds nothing fenced.
    expect(
      (yield* service.copyRelease({ projectId, operationId: id, reason: "again" })).released,
    ).toBe(false);
  }).pipe(Effect.provide(h.layer));
});

it.live("continues a folder copy only where the applied copy landed", () => {
  const folder = sourceFolder();
  const h = makeHarness({ endpoints: tailnet, workspaceRoot: folder });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const store = yield* MachineHandoffStore.MachineHandoffStore;
    const prepared = yield* service.prepare({
      ...preview,
      destination: {
        ...preview.destination,
        executionMode: "project-folder",
        coordinatorThreadId: threadId,
      },
    });
    const bundle = folderCopyBundle(prepared.bundle);
    expect((yield* failureOnly(service.receive(destinationPreview(bundle)))).code).toBe("conflict");
    const record: DestinationRecord = {
      version: 1,
      operationId: id,
      sourceUrl: "https://other.example.ts.net",
      token: "unused",
      sourceEnvironmentId: "other-env",
      sourceProjectId: projectId,
      sourceMachine: "Other Mac",
      mode: "copy-and-move",
      targetFolder: folder,
      title: "Project",
      selection: [],
      decisions: {},
      clone: [],
      mirror: false,
      state: "applied",
      failedStep: null,
      error: null,
      progress: null,
      disk: null,
      checks: [],
      warnings: [],
      unstable: [],
      committed: true,
      projectId,
      requestedProjectId: projectId,
      createdAt: "2026-10-19T00:00:00.000Z",
      updatedAt: "2026-10-19T00:00:00.000Z",
    };
    const directory = NodePath.join(store.root, "folder-copies", id);
    NodeFS.mkdirSync(directory, { recursive: true });
    const write = (value: DestinationRecord) =>
      NodeFS.writeFileSync(NodePath.join(directory, "operation.json"), JSON.stringify(value));
    write({ ...record, targetFolder: "/elsewhere" });
    expect((yield* failureOnly(service.receive(destinationPreview(bundle)))).code).toBe("conflict");
    write(record);
    expect((yield* service.receive(destinationPreview(bundle))).phase).toBe("ready");
    const result = yield* service.receive({ projectId, operationId: id, bundle, mode: "start" });
    expect(result.workspacePath).toBe(folder);
    expect(h.state.preflights).toBe(0);
    expect(h.state.materializations).toBe(0);
    expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding?.state).toBe("active");
  }).pipe(Effect.provide(h.layer));
});
