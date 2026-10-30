// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable real folders and scan polling.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  MachineHandoffError,
  ThreadId,
  type MachineHandoffBundle,
  type MachineHandoffPrepareInput,
} from "@specweave-studio/contracts";
import * as MachineHandoff from "./MachineHandoff.ts";
import * as MachineHandoffStore from "./MachineHandoffStore.ts";
import { ACTIVE_COPY_WARNING } from "./folderCopyPreparation.ts";
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

/** Exercise the same source endpoints the destination uses to finish its file copy. */
const commitCopiedFiles = (service: MachineHandoff.MachineHandoff["Service"], token: string) =>
  Effect.gen(function* () {
    const request = (action: string, value: unknown) =>
      service.serveFolderTransfer({
        method: "POST",
        path: `/${id}/${action}`,
        authorization: `Bearer ${token}`,
        body: async () => new TextEncoder().encode(JSON.stringify(value)),
      });
    expect(
      (yield* request("manifest", {
        selection: ["repository", "tracked", "untracked", "ignoredData"],
      })).status,
    ).toBe(202);
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = yield* service.copySourceStatus({ operationId: id });
      if (status.state === "ready") break;
      if (status.state === "failed") throw new Error(status.error ?? "The manifest failed");
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }
    expect((yield* request("commit", {})).status).toBe(200);
    expect((yield* service.copySourceStatus({ operationId: id })).state).toBe("committed");
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
    expect(status.summary?.warnings).toContain(ACTIVE_COPY_WARNING);
    expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding).toBeUndefined();
    expect(h.state.policyUpdates).toHaveLength(0);
  }).pipe(Effect.provide(h.layer));
});

it.live("names the source by its machine nickname, else its host label", () =>
  Effect.gen(function* () {
    const offerFrom = (machineNicknames?: Record<string, { name: string; updatedAt: string }>) => {
      const h = makeHarness({
        workspaceRoot: sourceFolder(),
        endpoints: tailnet,
        ...(machineNicknames ? { machineNicknames } : {}),
      });
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const offered = yield* service.copyOffer({
          projectId,
          operationId: id,
          mode: "copy-only",
          destinationEnvironmentId: other,
        });
        yield* scanned(service); // The source scan must settle before its private store closes.
        return offered;
      }).pipe(Effect.provide(h.layer));
    };
    const at = "2026-10-20T00:00:00.000Z";
    // Imported branches read swc/from-M4/…, not the shared or long host name.
    expect(
      (yield* offerFrom({
        "source-env": { name: "  M4 ", updatedAt: at },
        "other-env": { name: "Minis", updatedAt: at },
      })).sourceMachine,
    ).toBe("M4");
    expect(
      (yield* offerFrom({ "other-env": { name: "Minis", updatedAt: at } })).sourceMachine,
    ).toBe("Source Mac");
    // An empty nickname means "use the default name".
    expect((yield* offerFrom({ "source-env": { name: "", updatedAt: at } })).sourceMachine).toBe(
      "Source Mac",
    );
  }),
);

it.live("offers a moving copy while work runs but defers coordinator transfer", () => {
  const h = makeHarness({ workspaceRoot: sourceFolder(), endpoints: tailnet, busy: true });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const offer = yield* service.copyOffer({
      projectId,
      operationId: id,
      mode: "copy-and-move",
      destinationEnvironmentId: other,
    });
    expect(offer.mode).toBe("copy-and-move");
    const status = yield* scanned(service);
    expect(status.state).toBe("scanned");
    expect(status.summary?.warnings).toContain(ACTIVE_COPY_WARNING);
    // Copying and scanning do not change ownership; a context handoff stays guarded.
    expect((yield* failureOnly(service.prepare(copyPreview))).code).toBe("busy");
    expect(h.state.policyUpdates).toHaveLength(0);
    expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding).toBeUndefined();
  }).pipe(Effect.provide(h.layer));
});

it.live("does not treat an activity lookup failure as permission to copy", () => {
  // An empty real database deliberately lacks the activity projections.
  const h = makeHarness({ workspaceRoot: sourceFolder(), endpoints: tailnet, realDatabase: true });
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
    expect(error.code).toBe("invalid");
    expect(h.state.policyUpdates).toHaveLength(0);
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
    write({ ...record, unstable: ["README.md"] });
    expect((yield* failureOnly(service.receive(destinationPreview(bundle)))).code).toBe("conflict");
    write({ ...record, checks: [{ repo: ".", ok: false, problems: ["Git verification failed"] }] });
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

it.live("abandons an applied copy's unpublished context and rejects a delayed publish", () => {
  const h = makeHarness({ workspaceRoot: sourceFolder(), endpoints: tailnet });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const offer = yield* service.copyOffer({
      projectId,
      operationId: id,
      mode: "copy-and-move",
      destinationEnvironmentId: other,
    });
    yield* scanned(service);
    const prepared = yield* service.prepare(copyPreview);
    yield* commitCopiedFiles(service, offer.token);
    const released = yield* service.copyRelease({
      projectId,
      operationId: id,
      reason: "Start a fresh copy",
    });
    expect(released.released).toBe(false); // No ownership fence existed to release.
    expect((yield* service.copySourceStatus({ operationId: id })).state).toBe("released");
    expect((yield* failureOnly(service.prepare(copyPreview))).code).toBe("conflict");
    expect(
      (yield* failureOnly(
        service.prepare({ ...copyPreview, publish: true, expectedDigest: prepared.bundle.digest }),
      )).code,
    ).toBe("conflict");
    expect(h.state.policyUpdates).toHaveLength(0);
    expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding).toBeUndefined();
  }).pipe(Effect.provide(h.layer));
});

it.live("never abandons published ownership even when its current binding looks active", () => {
  const h = makeHarness({ workspaceRoot: sourceFolder(), endpoints: tailnet });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const offer = yield* service.copyOffer({
      projectId,
      operationId: id,
      mode: "copy-and-move",
      destinationEnvironmentId: other,
    });
    yield* scanned(service);
    const prepared = yield* service.prepare(copyPreview);
    yield* service.prepare({
      ...copyPreview,
      publish: true,
      expectedDigest: prepared.bundle.digest,
    });
    yield* commitCopiedFiles(service, offer.token);
    const current = h.projects.get(projectId)!;
    h.projects.set(projectId, {
      ...current,
      workspaceSettings: {
        ...current.workspaceSettings!,
        coordinatorBinding: { ...current.workspaceSettings!.coordinatorBinding!, state: "active" },
      },
    });
    expect(
      (yield* failureOnly(
        service.copyRelease({ projectId, operationId: id, reason: "Start fresh" }),
      )).code,
    ).toBe("refused");
    expect((yield* service.copySourceStatus({ operationId: id })).state).toBe("committed");
    expect(h.state.policyUpdates).toHaveLength(1);
  }).pipe(Effect.provide(h.layer));
});

it.live.each(["transferring", "transferred"] as const)(
  "never abandons a %s binding without a publication receipt",
  (state) => {
    const h = makeHarness({ workspaceRoot: sourceFolder(), endpoints: tailnet });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const offer = yield* service.copyOffer({
        projectId,
        operationId: id,
        mode: "copy-and-move",
        destinationEnvironmentId: other,
      });
      yield* commitCopiedFiles(service, offer.token);
      const current = h.projects.get(projectId)!;
      h.projects.set(projectId, {
        ...current,
        workspaceSettings: {
          ...current.workspaceSettings!,
          coordinatorBinding: { epoch: 1, operationId: id, state },
        },
      });
      expect(
        (yield* failureOnly(
          service.copyRelease({ projectId, operationId: id, reason: "Start fresh" }),
        )).code,
      ).toBe("refused");
      expect((yield* service.copySourceStatus({ operationId: id })).state).toBe("committed");
      expect(h.state.policyUpdates).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.live("does not abandon an applied copy when its authoritative project is missing", () => {
  const h = makeHarness({ workspaceRoot: sourceFolder(), endpoints: tailnet });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const offer = yield* service.copyOffer({
      projectId,
      operationId: id,
      mode: "copy-and-move",
      destinationEnvironmentId: other,
    });
    yield* commitCopiedFiles(service, offer.token);
    h.projects.delete(projectId);
    expect(
      (yield* failureOnly(
        service.copyRelease({ projectId, operationId: id, reason: "Start fresh" }),
      )).code,
    ).toBe("not_found");
    expect((yield* service.copySourceStatus({ operationId: id })).state).toBe("committed");
    expect(h.state.policyUpdates).toHaveLength(0);
  }).pipe(Effect.provide(h.layer));
});

it.live("serializes abandoning a copied context against publishing it", () => {
  const h = makeHarness({ workspaceRoot: sourceFolder(), endpoints: tailnet });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const offer = yield* service.copyOffer({
      projectId,
      operationId: id,
      mode: "copy-and-move",
      destinationEnvironmentId: other,
    });
    yield* scanned(service);
    const prepared = yield* service.prepare(copyPreview);
    yield* commitCopiedFiles(service, offer.token);
    const [released, published] = yield* Effect.all(
      [
        service
          .copyRelease({ projectId, operationId: id, reason: "Start fresh" })
          .pipe(Effect.result),
        service
          .prepare({ ...copyPreview, publish: true, expectedDigest: prepared.bundle.digest })
          .pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    expect(Number(Result.isSuccess(released)) + Number(Result.isSuccess(published))).toBe(1);
    const source = yield* service.copySourceStatus({ operationId: id });
    if (Result.isSuccess(released)) {
      expect(source.state).toBe("released");
      expect(h.state.policyUpdates).toHaveLength(0);
    } else {
      expect(source.state).toBe("committed");
      expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding?.state).toBe(
        "transferring",
      );
    }
  }).pipe(Effect.provide(h.layer));
});

it.live.each([
  { customCoordinator: false, relative: "." },
  { customCoordinator: true, relative: "." },
  { customCoordinator: false, relative: "repositories/acme/app" },
  { customCoordinator: true, relative: "repositories/acme/app" },
])(
  "preflights a registered copy with its exact logical identity (%j)",
  ({ customCoordinator, relative }) => {
    const folder = sourceFolder();
    const projectFolder = NodePath.join(folder, relative);
    NodeFS.mkdirSync(projectFolder, { recursive: true });
    const h = makeHarness({ endpoints: tailnet, workspaceRoot: projectFolder });
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
      const original = folderCopyBundle(prepared.bundle);
      const { digest: _originalDigest, ...contents } = original;
      const scoped = {
        ...contents,
        manifest: {
          ...contents.manifest,
          ...(relative !== "."
            ? { copyScope: { copyRoot: "/source/umbrella", projectRelativePath: relative } }
            : {}),
        },
      };
      const bundle = { ...scoped, digest: MachineHandoff.machineHandoffDigest(scoped) };
      const targetCoordinator = customCoordinator ? ThreadId.make("custom-coordinator") : threadId;
      const current = h.projects.get(projectId)!;
      h.projects.set(projectId, {
        ...current,
        workspaceSettings: {
          ...current.workspaceSettings!,
          coordinatorThreadId: targetCoordinator,
          logicalProject: {
            id: "existing-logical-project",
            title: "Existing destination",
            coordinatorId: "existing-logical-coordinator",
            members: [
              {
                environmentId: EnvironmentId.make("source-env"),
                projectId,
                coordinatorThreadId: targetCoordinator,
              },
            ],
          },
        },
      });
      const record: DestinationRecord = {
        version: 1,
        ...(relative !== "."
          ? { copyRoot: "/source/umbrella", projectRelativePath: relative }
          : {}),
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
      NodeFS.writeFileSync(NodePath.join(directory, "operation.json"), JSON.stringify(record));

      // Reusing only the physical project id is insufficient for an existing destination.
      const refusal = yield* failureOnly(service.receive(destinationPreview(bundle)));
      expect(refusal.code).toBe(customCoordinator ? "invalid" : "conflict");
      expect(h.state.policyUpdates).toHaveLength(0);

      const { digest: _digest, ...value } = bundle;
      const corrected = {
        ...value,
        destination: {
          ...bundle.destination!,
          logicalProjectId: "existing-logical-project",
          coordinatorThreadId: targetCoordinator,
        },
        logicalProject: {
          ...bundle.logicalProject!,
          members: bundle.logicalProject!.members.map((member) =>
            member.environmentId === "source-env" && member.projectId === projectId
              ? { ...member, coordinatorThreadId: targetCoordinator }
              : member,
          ),
        },
        coordinatorBinding: {
          ...bundle.coordinatorBinding!,
          successor: {
            ...bundle.coordinatorBinding!.successor!,
            coordinatorThreadId: targetCoordinator,
          },
        },
      };
      const accepted = { ...corrected, digest: MachineHandoff.machineHandoffDigest(corrected) };
      expect((yield* service.receive(destinationPreview(accepted))).phase).toBe("ready");
      expect(h.state.policyUpdates).toHaveLength(0); // Preview never takes ownership.
      const result = yield* service.receive({
        projectId,
        operationId: id,
        bundle: accepted,
        mode: "start",
      });
      expect(result.phase).toBe("started");
      expect(result.coordinatorThreadId).toBe(targetCoordinator);
      expect(result.workspacePath).toBe(projectFolder);
      expect(h.state.creations).toHaveLength(0);
      if (relative !== ".") {
        const mapping = JSON.parse(NodeFS.readFileSync(`${result.contextPath}-paths`, "utf8"));
        expect(mapping).toMatchObject({
          sourceCopyRoot: "/source/umbrella",
          destinationCopyRoot: folder,
          destinationProjectRoot: projectFolder,
        });
        expect(h.state.starts[0]?.prompt).toContain(`${result.contextPath}-paths`);
        expect(JSON.parse(NodeFS.readFileSync(result.contextPath!, "utf8")).context).toEqual(
          bundle.context,
        );
      }
    }).pipe(Effect.provide(h.layer));
  },
);

it.live(
  "offers the verified umbrella while keeping the source project and rechecks membership",
  () => {
    const folder = sourceFolder();
    const child = NodePath.join(folder, "custom/services/app");
    NodeFS.mkdirSync(child, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(folder, ".specweave"));
    const config = NodePath.join(folder, ".specweave/config.json");
    NodeFS.writeFileSync(
      config,
      JSON.stringify({ workspace: { repos: [{ path: "custom/services/app" }] } }),
    );
    const h = makeHarness({ workspaceRoot: child, endpoints: tailnet });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const scopes = yield* service.copyScopes({ projectId });
      expect(scopes.recommendedCopyRoot).toBe(NodeFS.realpathSync(folder));
      const offer = yield* service.copyOffer({
        projectId,
        operationId: id,
        mode: "copy-and-move",
        destinationEnvironmentId: other,
        copyRoot: folder,
      });
      expect(offer.projectRelativePath).toBe("custom/services/app");
      expect(offer.sourceProjectId).toBe(projectId);
      yield* scanned(service);
      const prepared = yield* service.prepare(copyPreview);
      expect(prepared.bundle.manifest.copyScope).toEqual({
        copyRoot: NodeFS.realpathSync(folder),
        projectRelativePath: "custom/services/app",
      });
      expect(h.projects.get(projectId)?.workspaceRoot).toBe(child);
      expect(
        (yield* failureOnly(
          service.copyOffer({
            projectId,
            operationId: id,
            mode: "copy-and-move",
            destinationEnvironmentId: other,
            copyRoot: child,
          }),
        )).code,
      ).toBe("invalid");
      NodeFS.writeFileSync(
        config,
        JSON.stringify({ workspace: { repos: [{ path: "different" }] } }),
      );
      expect(
        (yield* failureOnly(
          service.prepare({
            ...copyPreview,
            publish: true,
            expectedDigest: prepared.bundle.digest,
          }),
        )).code,
      ).toBe("source_changed");
      expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding).toBeUndefined();
    }).pipe(Effect.provide(h.layer));
  },
);

it.live("moves with source changes only after their list is reviewed and accepted", () => {
  const folder = sourceFolder();
  const h = makeHarness({ workspaceRoot: folder, endpoints: tailnet });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const offer = yield* service.copyOffer({
      projectId,
      operationId: id,
      mode: "copy-and-move",
      destinationEnvironmentId: other,
    });
    yield* scanned(service);
    yield* commitCopiedFiles(service, offer.token);
    const binding = () => h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding;
    const before = yield* service.prepare(copyPreview);
    // A saved preview is returned as it is; only publishing checks the source again.
    const publish = { ...copyPreview, publish: true, expectedDigest: before.bundle.digest };
    NodeFS.writeFileSync(NodePath.join(folder, "README.md"), "notes written after the copy\n");

    const refused = yield* failureOnly(service.prepare(publish));
    expect(refused.code).toBe("source_changed");
    expect(refused.message).not.toMatch(/Git/);
    expect(refused.changes).toMatchObject({
      total: 1,
      truncated: false,
      acceptable: true,
      rows: [{ path: "README.md", kind: "changed" }],
    });
    expect(binding()?.state).not.toBe("transferring");
    const wire = yield* Schema.encodeEffect(MachineHandoffError)(refused);
    const decoded = yield* Schema.decodeUnknownEffect(MachineHandoffError)(wire);
    expect(decoded.changes).toEqual(refused.changes);
    const digest = refused.changes!.digest;

    // Only a list this source produced counts.
    const madeUp = { ...publish, acceptedSourceChanges: "f".repeat(64) };
    expect((yield* failureOnly(service.prepare(madeUp))).code).toBe("source_changed");
    // A path that was not in the accepted list needs its own review.
    const accepted = { ...publish, acceptedSourceChanges: digest };
    NodeFS.writeFileSync(NodePath.join(folder, "later.md"), "new work\n");
    const wider = yield* failureOnly(service.prepare(accepted));
    expect(wider.changes?.digest).not.toBe(digest);
    expect(wider.changes?.rows.map((row) => row.path)).toEqual(["README.md", "later.md"]);
    NodeFS.rmSync(NodePath.join(folder, "later.md"));
    expect(binding()?.state).not.toBe("transferring");

    // Still writing the accepted file does not bounce the move.
    NodeFS.appendFileSync(NodePath.join(folder, "README.md"), "and more\n");
    const published = yield* service.prepare(accepted);
    expect(published.publication).toBe("published");
    expect(binding()?.state).toBe("transferring");
    const drift = yield* service.copyDrift({ projectId, operationId: id });
    expect(drift.drift.rows.map((row) => row.path)).toEqual(["README.md"]);
    expect(drift.leftOnSource).toMatchObject({ digest: drift.drift.digest, total: 1 });
  }).pipe(Effect.provide(h.layer));
});

it.live("records what a move left on the source only once the move goes ahead", () => {
  const folder = sourceFolder();
  const h = makeHarness({ workspaceRoot: folder, endpoints: tailnet });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const offer = yield* service.copyOffer({
      projectId,
      operationId: id,
      mode: "copy-and-move",
      destinationEnvironmentId: other,
    });
    yield* scanned(service);
    yield* commitCopiedFiles(service, offer.token);
    const before = yield* service.prepare(copyPreview);
    const publish = { ...copyPreview, publish: true, expectedDigest: before.bundle.digest };
    NodeFS.writeFileSync(NodePath.join(folder, "README.md"), "notes written after the copy\n");
    const digest = (yield* failureOnly(service.prepare(publish))).changes!.digest;

    // The list is accepted, but newer coordinator context stops the move after the drift check.
    h.state.text = "newer work";
    const accepted = { ...publish, acceptedSourceChanges: digest };
    expect((yield* failureOnly(service.prepare(accepted))).code).toBe("source_changed");
    const binding = () => h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding;
    expect(binding()?.state).not.toBe("transferring");
    expect((yield* service.copyDrift({ projectId, operationId: id })).leftOnSource).toBeUndefined();

    // Put back, nothing differs: the move goes ahead and leaves nothing listed here.
    NodeFS.writeFileSync(NodePath.join(folder, "README.md"), "notes\n");
    h.state.text = "Continue the actual pending change";
    expect((yield* service.prepare(accepted)).publication).toBe("published");
    expect(binding()?.state).toBe("transferring");
    expect((yield* service.copyDrift({ projectId, operationId: id })).leftOnSource).toBeUndefined();
  }).pipe(Effect.provide(h.layer));
});
