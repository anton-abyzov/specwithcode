// @effect-diagnostics nodeBuiltinImport:off - disposable real Git recovery fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
const failureOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return result.failure;
      throw new Error("Expected request to fail");
    }),
  );
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import { HandoffGitError } from "./handoffGitTypes.ts";
import {
  CommandId,
  EventId,
  MessageId,
  EnvironmentId,
  MachineHandoffError,
  ProjectWorkspaceError,
  ProjectId,
  ThreadId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  type Project,
  type MachineHandoffBundle,
  type MachineHandoffReceiveInput,
} from "@specweave-studio/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectWorkspaceService from "../project/ProjectWorkspaceService.ts";
import * as ProjectCoordinatorService from "../project/ProjectCoordinatorService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as HandoffGit from "./handoffGit.ts";
import * as MachineHandoffStore from "./MachineHandoffStore.ts";
import * as MachineHandoff from "./MachineHandoff.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";

import {
  makeHarness,
  imported,
  preview,
  destinationPreview,
  id,
  projectId,
  threadId,
  manifest,
  legacyContinuationPrompt,
  previousApprovalContinuationPrompt,
} from "./MachineHandoff.test-fixtures.ts";
describe("MachineHandoff", () => {
  it.effect("retains real context privately without publishing or starting during preview", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const result = yield* service.prepare(preview);
      expect(result.publication).toBe("unpublished");
      expect(result.bundle.context.notes[0]?.content).toBe("Actual durable decision");
      expect(result.bundle.context.threads[0]?.messages[0]?.text).toBe(h.state.text);
      expect(result.messageCount).toBe(1);
      expect(h.state.pushes).toBe(0);
      expect(h.state.starts).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "publishes only a confirmed unchanged snapshot, then replays despite later changes",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const first = yield* service.prepare(preview);
        const confirmed = { ...preview, publish: true, expectedDigest: first.bundle.digest };
        const published = yield* service.prepare(confirmed);
        expect(published.publication).toBe("published");
        h.state.busy = true;
        h.state.text = "newer work";
        expect((yield* service.prepare(confirmed)).bundle).toEqual(published.bundle);
        expect((yield* service.prepare(preview)).publication).toBe("published");
        expect(h.state.pushes).toBe(1);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("refuses unpublished source changes before pushing", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = yield* service.prepare(preview);
      h.state.head = "c".repeat(40);
      const result = yield* failureOnly(
        service.prepare({ ...preview, publish: true, expectedDigest: first.bundle.digest }),
      );
      expect(result.code).toBe("source_changed");
      expect(h.state.pushes).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "starts once in the isolated workspace and replays even while its coordinator runs",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const bundle = imported((yield* service.prepare(preview)).bundle);
        const input = { projectId, operationId: id, bundle, mode: "start" as const };
        const ready = yield* service.receive(destinationPreview(bundle));
        expect(ready.phase).toBe("ready");
        expect(h.state.materializations).toBe(0);
        const first = yield* service.receive(input);
        expect(first.phase).toBe("started");
        expect(first.projectId).not.toBe(projectId);
        expect(h.state.creations).toEqual([first.workspacePath]);
        expect(h.state.starts[0]?.prompt).toContain(first.contextPath);
        expect(h.state.starts[0]?.prompt).not.toContain(h.state.text);
        h.state.busy = true;
        expect((yield* service.receive(input)).replayed).toBe(true);
        expect((yield* service.receive(destinationPreview(bundle))).phase).toBe("started");
        expect(h.state.starts).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("preflights metadata without retaining context or launching work", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const store = yield* MachineHandoffStore.MachineHandoffStore;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      const ready = yield* service.receive(destinationPreview(bundle));
      expect(ready.phase).toBe("ready");
      expect(h.state.preflights).toBe(1);
      expect(h.state.materializations).toBe(0);
      expect(h.state.starts).toHaveLength(0);
      expect(yield* store.read(`context-${id}`)).toBeNull();
      expect(yield* store.read(`destination-${id}`)).toBeNull();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("asks for only supported scoped approval and stops after denial", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      yield* service.receive({ projectId, operationId: id, bundle, mode: "start" });
      const prompt = h.state.starts[0]!.prompt;
      expect(prompt).toContain("user-authorized write is sandbox-blocked");
      expect(prompt).toContain("no approval has been denied");
      expect(prompt).toContain("request only the access needed for that operation");
      expect(prompt).toContain("provider's supported native approval flow");
      expect(prompt).toContain("Pass this rule to delegated workers");
      expect(prompt).toContain("Do not automatically grant access, change permission modes");
      expect(prompt).toContain("If approval is unavailable or explicitly denied, stop");
      expect(prompt).toContain("do not bypass the restriction or retry the denied operation");
      expect(prompt).not.toMatch(/sandbox_permissions|require_escalated|Full Access|chmod/);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "reads the received context before generic startup and delegates only its assignment",
    () => {
      const historicalStartup = "Run specweave pickup and choose the unrelated open increment";
      const h = makeHarness({ text: historicalStartup });
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const bundle = imported((yield* service.prepare(preview)).bundle);
        const received = yield* service.receive({
          projectId,
          operationId: id,
          bundle,
          mode: "start",
        });
        const prompt = h.state.starts[0]!.prompt;
        expect(
          prompt.startsWith(`First read the retained handoff context at ${received.contextPath}`),
        ).toBe(true);
        expect(prompt).toContain("before running any repository startup command");
        expect(prompt).toContain("already contains the active received handoff");
        expect(prompt).toContain("Resume only its current unfinished assignment");
        expect(prompt).toContain("Do not run `specweave pickup` for startup discovery");
        expect(prompt).toContain("fetch or apply another handoff, or select unrelated increments");
        expect(prompt).toContain("current user intent, applicable local repository instructions");
        expect(prompt).toContain("command allowlists and permissions");
        expect(prompt).toContain("Pass this context-first rule to delegated workers");
        expect(prompt).toContain("delegate only the task retained here");
        expect(prompt).toContain(received.workspacePath);
        expect(prompt).not.toContain(historicalStartup);
        expect(h.state.starts).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect(
    "replays older receipts using the locally retained bundle without source context",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const store = yield* MachineHandoffStore.MachineHandoffStore;
        const bundle = imported((yield* service.prepare(preview)).bundle);
        yield* service.receive({ projectId, operationId: id, bundle, mode: "start" });
        const record = (yield* store.read(`destination-${id}`)) as Record<string, unknown>;
        const { metadata: _metadata, ...legacy } = record;
        yield* store.write(`destination-${id}`, legacy);
        expect((yield* service.receive(destinationPreview(bundle))).phase).toBe("started");
        expect(
          (yield* failureOnly(
            service.receive({
              ...destinationPreview(bundle),
              sourceThreadId: ThreadId.make("other-thread"),
            } as MachineHandoffReceiveInput),
          )).code,
        ).toBe("conflict");
        yield* store.write(`context-${id}`, {
          ...bundle,
          context: { ...bundle.context, goal: "Changed retained context" },
        });
        expect((yield* failureOnly(service.receive(destinationPreview(bundle)))).code).toBe(
          "conflict",
        );
        yield* store.write(`context-${id}`, { ...bundle, extraInstructions: "Unbound text" });
        expect((yield* failureOnly(service.receive(destinationPreview(bundle)))).code).toBe(
          "conflict",
        );
        expect(h.state.starts).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("refuses a contextless start before Git or coordinator work", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      const incomplete = {
        ...destinationPreview(bundle),
        mode: "start",
      } as unknown as MachineHandoffReceiveInput;
      expect((yield* failureOnly(service.receive(incomplete))).code).toBe("invalid");
      expect(h.state.preflights).toBe(0);
      expect(h.state.starts).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect.each([
    "sourceEnvironmentId",
    "sourceProjectId",
    "sourceThreadId",
    "manifest",
    "digest",
    "projectId",
    "operationId",
  ] as const)("refuses a changed %s in metadata-only receipt replay", (field) => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      yield* service.receive({ projectId, operationId: id, bundle, mode: "start" });
      const input = destinationPreview(bundle);
      const changed = {
        ...input,
        [field]:
          field === "manifest"
            ? {
                ...bundle.manifest,
                repositories: bundle.manifest.repositories.map((repository) => ({
                  ...repository,
                  identity: "github.com/other/repository",
                })),
              }
            : field === "digest"
              ? "c".repeat(64)
              : field === "operationId"
                ? "22222222-2222-4222-8222-222222222222"
                : field === "projectId"
                  ? "other-project"
                  : "other-source",
      } as MachineHandoffReceiveInput;
      const error = yield* failureOnly(service.receive(changed));
      expect(error.code).toBe(
        field === "operationId" ? "invalid" : field === "projectId" ? "not_found" : "conflict",
      );
      expect(h.state.starts).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("retains full-bundle size validation at the confirmed start boundary", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const prepared = (yield* service.prepare(preview)).bundle;
      const bundle = imported({
        ...prepared,
        context: {
          ...prepared.context,
          threads: prepared.context.threads.map((thread) => ({
            ...thread,
            messages: thread.messages.map((message) => ({
              ...message,
              text: "x".repeat(2_097_152),
            })),
          })),
        },
      });
      expect(
        (yield* failureOnly(service.receive({ projectId, operationId: id, bundle, mode: "start" })))
          .code,
      ).toBe("too_large");
      expect(h.state.preflights).toBe(0);
      expect(h.state.starts).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("keeps a failed launch retryable with the same deterministic command", () => {
    const h = makeHarness({ launchFailure: true });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      const input = { projectId, operationId: id, bundle, mode: "start" as const };
      expect((yield* failureOnly(service.receive(input))).code).toBe("launch_failed");
      h.state.launchFailure = false;
      expect((yield* service.receive(input)).phase).toBe("started");
      expect(h.state.creations).toHaveLength(1);
      expect(h.state.starts[0]?.commandId).toBe(`machine-handoff-start:${id}`);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("refuses a changed digest on destination replay", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      yield* service.receive({ projectId, operationId: id, bundle, mode: "start" });
      const altered = imported({
        ...bundle,
        context: { ...bundle.context, goal: "Different work" },
      });
      expect(
        (yield* failureOnly(
          service.receive({ projectId, operationId: id, bundle: altered, mode: "start" }),
        )).code,
      ).toBe("conflict");
      expect(h.state.starts).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect.each([
    ["busy source", { busy: true }, "busy"],
    ["missing source chat", { missingThread: true }, "not_found"],
    ["oversized context", { text: "x".repeat(2_097_153) }, "too_large"],
  ] as const)("refuses %s without side effects", ([_name, options, code]) => {
    const h = makeHarness(options);
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      expect((yield* failureOnly(service.prepare(preview))).code).toBe(code);
      expect(h.state.pushes).toBe(0);
      expect(h.state.starts).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("pins destination model policy and clears remote worker routing before launch", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      const result = yield* service.receive({ projectId, operationId: id, bundle, mode: "start" });
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      expect(settings.projectSettingsOverrides[result.projectId]).toMatchObject({
        providerLimitAction: "ask",
        providerLimitFallbackModelSelection: null,
        providerLimitRedeemResets: false,
        providerLimitSpendCredits: false,
        providerLimitUseApiCredits: false,
      });
      expect(h.projects.get(result.projectId)?.title).toBe("Project");
      expect(
        h.projects.get(result.projectId)?.workspaceSettings?.coordinatorModelSelection,
      ).toEqual(h.projects.get(projectId)?.defaultModelSelection);
      expect(h.projects.get(result.projectId)?.workspaceSettings?.workerMachine).toBeNull();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("carries a Full access coordinator's access to the destination project", () => {
    // One harness plays both machines: this machine's own default is approval-required.
    const h = makeHarness({
      coordinatorRuntimeMode: "full-access",
      defaultRuntimeMode: "approval-required",
    });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const prepared = yield* service.prepare(preview);
      expect(prepared.bundle.context.runtimeMode).toBe("full-access");
      const bundle = imported(prepared.bundle);
      const result = yield* service.receive({ projectId, operationId: id, bundle, mode: "start" });
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      expect(settings.defaultRuntimeMode).toBe("approval-required");
      // The coordinator starts on the project's saved mode, so it continues on Full access.
      expect(settings.projectSettingsOverrides[result.projectId]?.defaultRuntimeMode).toBe(
        "full-access",
      );
      expect(h.state.starts).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("uses the source project's saved mode when no coordinator mode is known", () => {
    const h = makeHarness({ defaultRuntimeMode: "auto" });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const prepared = yield* service.prepare(preview);
      expect(prepared.bundle.context.runtimeMode).toBe("auto");
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("keeps the destination's own default for a bundle without a mode", () => {
    const h = makeHarness({
      coordinatorRuntimeMode: "full-access",
      defaultRuntimeMode: "approval-required",
    });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const prepared = yield* service.prepare(preview);
      const { runtimeMode: _runtimeMode, ...olderContext } = prepared.bundle.context;
      const bundle = imported({ ...prepared.bundle, context: olderContext });
      expect(bundle.context.runtimeMode).toBeUndefined();
      const result = yield* service.receive({ projectId, operationId: id, bundle, mode: "start" });
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      expect(settings.projectSettingsOverrides[result.projectId]?.defaultRuntimeMode).toBe(
        "approval-required",
      );
    }).pipe(Effect.provide(h.layer));
  });
  it.effect.each(["/source/project", "/source/project/nested", "/source"])(
    "refuses another active owner at %s",
    (busyRoot) => {
      const h = makeHarness({ busy: true, busyProject: "another-owner", busyRoot });
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        expect((yield* failureOnly(service.prepare(preview))).code).toBe("busy");
        expect(h.state.pushes).toBe(0);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("allows an unrelated busy workspace", () => {
    const h = makeHarness({
      busy: true,
      busyProject: "another-owner",
      busyRoot: "/unrelated/project",
    });
    return Effect.gen(function* () {
      expect((yield* (yield* MachineHandoff.MachineHandoff).prepare(preview)).publication).toBe(
        "unpublished",
      );
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("refuses unconfirmed publication and a changed confirmation digest", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      expect((yield* failureOnly(service.prepare({ ...preview, publish: true }))).code).toBe(
        "conflict",
      );
      yield* service.prepare(preview);
      expect(
        (yield* failureOnly(
          service.prepare({ ...preview, publish: true, expectedDigest: "0".repeat(64) }),
        )).code,
      ).toBe("conflict");
      expect(h.state.pushes).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("refuses changed context before publication", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = yield* service.prepare(preview);
      h.state.text = "A newly requested task";
      expect(
        (yield* failureOnly(
          service.prepare({ ...preview, publish: true, expectedDigest: first.bundle.digest }),
        )).code,
      ).toBe("source_changed");
      expect(h.state.pushes).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "rejects active destination, tampering, and same-machine import before materialization",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const source = (yield* service.prepare(preview)).bundle;
        const bundle = imported(source);
        const input = { projectId, operationId: id, bundle, mode: "start" as const };
        h.state.busy = true;
        expect((yield* failureOnly(service.receive(input))).code).toBe("busy");
        h.state.busy = false;
        expect((yield* failureOnly(service.receive({ ...input, bundle: source }))).code).toBe(
          "invalid",
        );
        expect(
          (yield* failureOnly(
            service.receive({ ...input, bundle: { ...bundle, digest: "0".repeat(64) } }),
          )).code,
        ).toBe("invalid");
        expect(h.state.materializations).toBe(0);
        expect(h.state.starts).toHaveLength(0);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("reports a destination identity mismatch without exposing Git details", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      h.state.gitFailure = new HandoffGitError({ stage: "preflight", reason: "identity-mismatch" });
      expect(
        (yield* failureOnly(service.receive({ projectId, operationId: id, bundle, mode: "start" })))
          .code,
      ).toBe("identity_mismatch");
      expect(h.state.materializations).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("explains unsafe paths before receiving context or creating work", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const store = yield* MachineHandoffStore.MachineHandoffStore;
      const fs = yield* FileSystem.FileSystem;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      h.state.gitFailure = new HandoffGitError({
        stage: "preflight",
        reason: "unsafe-path",
        cause: new Error("/private/example/repository token=private-test-value"),
      });
      for (const input of [
        destinationPreview(bundle),
        { projectId, operationId: id, bundle, mode: "start" as const },
      ]) {
        const error = yield* failureOnly(service.receive(input));
        expect(error.code).toBe("unsafe_path");
        expect(error.message).toContain("symbolic link");
        expect(error.message).not.toContain("remote access");
        expect(JSON.stringify(error)).not.toContain("private-test-value");
        expect(JSON.stringify(error)).not.toContain("/private/example");
      }
      expect(h.state.materializations).toBe(0);
      expect(h.state.creations).toHaveLength(0);
      expect(h.state.starts).toHaveLength(0);
      expect(yield* fs.exists(`${store.root}/destination-${id}`)).toBe(false);
      expect(yield* fs.exists(`${store.root}/context-${id}`)).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("keeps context private and turns corrupt durable JSON into a typed refusal", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const store = yield* MachineHandoffStore.MachineHandoffStore;
      const fs = yield* FileSystem.FileSystem;
      yield* service.prepare(preview);
      const record = `${store.root}/source-${id}`;
      // Windows has no POSIX mode bits to check.
      if (process.platform !== "win32") {
        expect(Number((yield* fs.stat(record)).mode) & 0o777).toBe(0o600);
        expect(Number((yield* fs.stat(store.root)).mode) & 0o777).toBe(0o700);
      }
      yield* fs.writeFileString(record, "invalid json");
      expect((yield* failureOnly(service.prepare(preview))).code).toBe("storage_failed");
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "checks active ownership against migrated SQL records and permits only terminal records",
    () => {
      const h = makeHarness({ realDatabase: true });
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('another-owner','Owner','/source/project','[]','2026-10-13T00:00:00Z','2026-10-13T00:00:00Z')`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES ('active-thread','another-owner','Owner','codex','full-access','default','2026-10-13T00:00:00Z','2026-10-13T00:00:00Z','{}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('active-run','active-thread',1,'codex','running','2026-10-13T00:00:00Z','{}')`;
        expect((yield* failureOnly(service.prepare(preview))).code).toBe("busy");
        yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed'`;
        yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES ('request','active-thread','node','approval','pending','2026-10-13T00:00:00Z','{}')`;
        expect((yield* failureOnly(service.prepare(preview))).code).toBe("busy");
        yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status='resolved'`;
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at) VALUES ('effect','command','active-thread','provider-turn.start','{}','pending',0,'2026-10-13T00:00:00Z','2026-10-13T00:00:00Z','2026-10-13T00:00:00Z')`;
        expect((yield* failureOnly(service.prepare(preview))).code).toBe("busy");
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status='succeeded'`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES ('session','active-thread','codex','running','2026-10-13T00:00:00Z','{}')`;
        expect((yield* failureOnly(service.prepare(preview))).code).toBe("busy");
        yield* sql`UPDATE orchestration_v2_projection_provider_sessions SET status='ready'`;
        expect((yield* service.prepare(preview)).publication).toBe("unpublished");
        expect(h.state.pushes).toBe(0);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect(
    "refuses uncheckpointed worker code and retains proven historical workspace metadata",
    () => {
      const h = makeHarness({ workerPath: "/other/worker" });
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        h.state.workerCheckpointFailure = true;
        expect((yield* failureOnly(service.prepare(preview))).code).toBe("worker_checkpoint");
        expect(h.state.pushes).toBe(0);
        h.state.workerCheckpointFailure = false;
        const snapshot = yield* service.prepare(preview);
        expect(snapshot.bundle.context.threads[0]).toMatchObject({
          branch: "main",
          worktreePath: "/other/worker",
        });
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("refuses linked private records and unsafe Git workspace directories", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const store = yield* MachineHandoffStore.MachineHandoffStore;
      const fs = yield* FileSystem.FileSystem;
      yield* store.write("original", { retained: true });
      yield* fs.symlink(`${store.root}/original`, `${store.root}/linked`);
      expect((yield* failureOnly(store.read("linked"))).code).toBe("storage_failed");
      const elsewhere = `${store.root}-elsewhere`;
      yield* fs.makeDirectory(elsewhere);
      yield* fs.symlink(elsewhere, `${store.root}/git`);
      expect((yield* failureOnly(store.prepareWorktreeParent)).code).toBe("storage_failed");
      yield* fs.remove(store.root, { recursive: true });
      yield* fs.symlink(elsewhere, store.root);
      expect((yield* failureOnly(store.write("refused", { retained: true }))).code).toBe(
        "storage_failed",
      );
      expect(yield* fs.exists(`${elsewhere}/refused`)).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "reuses durable command identity after a receipt write fails and the service restarts",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const original = yield* MachineHandoffStore.MachineHandoffStore;
        const source = yield* (yield* MachineHandoff.MachineHandoff).prepare(preview);
        const input = {
          projectId,
          operationId: id,
          bundle: imported(source.bundle),
          mode: "start" as const,
        };
        let failReceipt = true;
        const interruptedStore = MachineHandoffStore.MachineHandoffStore.of({
          ...original,
          write: (key, value) => {
            if (
              failReceipt &&
              key.startsWith("destination-") &&
              typeof value === "object" &&
              value !== null &&
              "receipt" in value &&
              value.receipt !== null
            ) {
              failReceipt = false;
              return Effect.fail(new MachineHandoffError({ code: "storage_failed" }));
            }
            return original.write(key, value);
          },
        });
        const first = yield* Effect.gen(function* () {
          return yield* failureOnly((yield* MachineHandoff.MachineHandoff).receive(input));
        }).pipe(
          Effect.provide(Layer.fresh(MachineHandoff.layer)),
          Effect.provideService(MachineHandoffStore.MachineHandoffStore, interruptedStore),
        );
        expect(first.code).toBe("storage_failed");
        const retried = yield* Effect.gen(function* () {
          return yield* (yield* MachineHandoff.MachineHandoff).receive(input);
        }).pipe(Effect.provide(Layer.fresh(MachineHandoff.layer)));
        expect(retried.phase).toBe("started");
        expect(h.state.creations).toHaveLength(1);
        expect(h.state.starts).toHaveLength(1);
        expect(h.state.sendAttempts).toEqual([
          `machine-handoff-start:${id}`,
          `machine-handoff-start:${id}`,
        ]);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

const recoveryDirectories: string[] = [];
afterEach(() => {
  for (const directory of recoveryDirectories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});
const fixtureGit = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Handoff Test",
      "-c",
      "user.email=handoff@example.invalid",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
const realGitRecoveryFixture = () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "handoff-recovery-")),
  );
  recoveryDirectories.push(root);
  const remote = NodePath.join(root, "remote.git");
  const source = NodePath.join(root, "source");
  const destination = NodePath.join(root, "destination");
  fixtureGit(root, "init", "--bare", "--initial-branch=main", remote);
  fixtureGit(root, "init", "--initial-branch=main", source);
  NodeFS.writeFileSync(NodePath.join(source, "progress.ts"), "export const progress = 0;\n");
  fixtureGit(source, "add", ".");
  fixtureGit(source, "commit", "-m", "Retained checkpoint");
  fixtureGit(source, "remote", "add", "origin", remote);
  fixtureGit(source, "push", "-u", "origin", "main");
  fixtureGit(root, "clone", remote, destination);
  return { root, source, destination };
};
const recoveryEventLayer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);
const recoveryGitLayer = HandoffGit.layer.pipe(Layer.provide(ProcessRunner.layer));
type RecoveryEvent =
  | "accepted"
  | "none"
  | "rejected"
  | "wrong-text"
  | "wrong-thread"
  | "wrong-message"
  | "wrong-command"
  | "wrong-author";
const recoveryScenario = (
  eventKind: RecoveryEvent,
  changeBinding?: "prompt" | "context" | "workspace" | "thread",
  legacyRecord = false,
  legacyPrompt: boolean | "approval" = false,
) => {
  const h = makeHarness();
  const fixture = realGitRecoveryFixture();
  h.projects.set(projectId, { ...h.projects.get(projectId)!, workspaceRoot: fixture.destination });
  return Effect.gen(function* () {
    const store = yield* MachineHandoffStore.MachineHandoffStore;
    const sink = yield* EventSink.EventSinkV2;
    const git = yield* HandoffGit.HandoffGit;
    const retained = (yield* (yield* MachineHandoff.MachineHandoff).prepare(preview)).bundle;
    const actualManifest = yield* git.inspect({ operationId: id, workspaceRoot: fixture.source });
    yield* git.publish({ workspaceRoot: fixture.source, manifest: actualManifest, publish: true });
    const { digest: _oldDigest, ...content } = { ...imported(retained), manifest: actualManifest };
    const bundle = { ...content, digest: MachineHandoff.machineHandoffDigest(content) };
    let sends = 0;
    let progressPath = "";
    const coordinator = ProjectCoordinatorService.ProjectCoordinatorService.of({
      start: () => Effect.die("must use send"),
      nextTurnModel: () => Effect.succeed(undefined),
      route: () => Effect.die("unused"),
      coordinatorModes: () => Effect.die("unused"),
      send: (input) =>
        Effect.gen(function* () {
          sends++;
          let acceptedPrompt = input.prompt;
          if (legacyPrompt) {
            const saved = (yield* store.read(`destination-${id}`)) as {
              launch: { contextPath: string; workspacePath: string; prompt: string };
            };
            acceptedPrompt = (
              legacyPrompt === "approval"
                ? previousApprovalContinuationPrompt
                : legacyContinuationPrompt
            )(saved.launch.contextPath, saved.launch.workspacePath);
            yield* store.write(`destination-${id}`, {
              ...saved,
              launch: { ...saved.launch, prompt: acceptedPrompt },
            });
          }
          const threadId = ThreadId.make(`project-coordinator:${input.projectId}`);
          const commandId = CommandId.make(
            `coordinator-send:${input.projectId}:${input.commandId}`,
          );
          const now = DateTime.makeUnsafe("2026-10-13T00:00:00Z");
          if (eventKind === "rejected") {
            yield* sink.commitRejectedCommand({
              commandId,
              threadId,
              commandType: "message.dispatch",
              rejectedAt: now,
              error: "Rejected fixture command",
            });
            return yield* new ProjectWorkspaceError({
              projectId: input.projectId,
              code: "operation_failed",
            });
          }
          if (eventKind === "none")
            return yield* new ProjectWorkspaceError({
              projectId: input.projectId,
              code: "operation_failed",
            });
          yield* sink.write({
            commandId:
              eventKind === "wrong-command" ? CommandId.make("foreign-command") : commandId,
            events: [
              {
                id: EventId.make("handoff-accepted-message"),
                type: "message.updated",
                threadId: eventKind === "wrong-thread" ? ThreadId.make("foreign-thread") : threadId,
                occurredAt: now,
                payload: {
                  id:
                    eventKind === "wrong-message"
                      ? MessageId.make("foreign-message")
                      : MessageId.make(commandId),
                  threadId,
                  role: "user",
                  text: eventKind === "wrong-text" ? "Different intent" : acceptedPrompt,
                  attachments: [],
                  runId: null,
                  nodeId: null,
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                  createdBy: eventKind === "wrong-author" ? "system" : "user",
                  creationSource: "web",
                },
              },
            ],
          });
          progressPath = NodePath.join(
            h.projects.get(input.projectId)!.workspaceRoot,
            "progress.ts",
          );
          NodeFS.writeFileSync(progressPath, "export const progress = 993;\n");
          return { threadId, created: true };
        }).pipe(
          Effect.mapError(
            () =>
              new ProjectWorkspaceError({ projectId: input.projectId, code: "operation_failed" }),
          ),
        ),
    });
    let failReceipt = true;
    const interrupted = MachineHandoffStore.MachineHandoffStore.of({
      ...store,
      write: (key, value) => {
        if (
          failReceipt &&
          key.startsWith("destination-") &&
          typeof value === "object" &&
          value !== null &&
          "receipt" in value &&
          value.receipt !== null
        ) {
          failReceipt = false;
          return Effect.fail(new MachineHandoffError({ code: "storage_failed" }));
        }
        return store.write(key, value);
      },
    });
    const receive = (mode: "start" | "preview" = "start") =>
      Effect.gen(function* () {
        return yield* (yield* MachineHandoff.MachineHandoff).receive(
          mode === "preview"
            ? destinationPreview(bundle)
            : { projectId, operationId: id, bundle, mode },
        );
      }).pipe(
        Effect.provide(Layer.fresh(MachineHandoff.layer)),
        // Fresh service instances recover from the same real SQLite database and private files.
        Effect.provide(Layer.fresh(EventSink.layer)),
        Effect.provideService(MachineHandoffStore.MachineHandoffStore, interrupted),
        Effect.provideService(ProjectCoordinatorService.ProjectCoordinatorService, coordinator),
      );
    const first = yield* failureOnly(receive());
    expect(first.code).toBe(
      eventKind === "none" || eventKind === "rejected" ? "launch_failed" : "storage_failed",
    );
    expect(sends).toBe(1);
    expect(yield* store.read(`destination-${id}`)).toMatchObject({
      configured: true,
      receipt: null,
      launch: { projectId: `machine-handoff:${id}` },
    });
    if (legacyRecord) {
      const record = (yield* store.read(`destination-${id}`)) as Record<string, unknown>;
      const { metadata: _metadata, ...legacy } = record;
      yield* store.write(`destination-${id}`, legacy);
    }
    if (changeBinding === "prompt") {
      const saved = (yield* store.read(`destination-${id}`)) as { launch: { prompt: string } };
      yield* store.write(`destination-${id}`, {
        ...saved,
        launch: { ...saved.launch, prompt: "Changed persisted prompt" },
      });
    } else if (changeBinding === "context") {
      yield* store.write(`context-${id}`, {
        ...bundle,
        context: { ...bundle.context, instructions: "Changed retained intent" },
      });
    } else if (changeBinding) {
      const isolatedId = `machine-handoff:${id}`;
      const isolated = h.projects.get(isolatedId)!;
      h.projects.set(
        isolatedId,
        changeBinding === "workspace"
          ? { ...isolated, workspaceRoot: `${isolated.workspaceRoot}-changed` }
          : {
              ...isolated,
              workspaceSettings: {
                ...isolated.workspaceSettings!,
                coordinatorThreadId: ThreadId.make("foreign-coordinator"),
              },
            },
      );
    }
    // Even the registered checkout may advance after acceptance. Recovery must not touch it.
    NodeFS.writeFileSync(NodePath.join(fixture.destination, "new-user-work.ts"), "preserve me\n");
    if (eventKind === "accepted" && !changeBinding) {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('busy-owner','Owner',${fixture.destination},'[]','2026-10-13T00:00:00Z','2026-10-13T00:00:00Z')`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES ('busy-thread','busy-owner','Owner','codex','full-access','default','2026-10-13T00:00:00Z','2026-10-13T00:00:00Z','{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('busy-run','busy-thread',1,'codex','running','2026-10-13T00:00:00Z','{}')`;
      const recovered = yield* receive("preview");
      expect(recovered).toMatchObject({
        phase: "started",
        replayed: true,
        projectId: `machine-handoff:${id}`,
        coordinatorThreadId: `project-coordinator:machine-handoff:${id}`,
      });
      expect(yield* receive()).toEqual(recovered);
      expect(NodeFS.readFileSync(progressPath, "utf8")).toBe("export const progress = 993;\n");
      expect(fixtureGit(NodePath.dirname(progressPath), "status", "--porcelain")).toContain(
        "progress.ts",
      );
      expect(yield* store.read(`destination-${id}`)).toMatchObject({ receipt: recovered });
    } else {
      const failure = yield* failureOnly(receive());
      expect(failure.code).toBe(
        legacyPrompt &&
          (eventKind === "none" || eventKind === "rejected" || eventKind === "wrong-command")
          ? "conflict"
          : eventKind === "none" || eventKind === "rejected" || eventKind === "wrong-command"
            ? "dirty_destination"
            : "conflict",
      );
      expect(yield* store.read(`destination-${id}`)).toMatchObject({ receipt: null });
    }
    expect(sends).toBe(1);
    expect(fixtureGit(fixture.destination, "branch", "--show-current")).toBe("main");
    expect(
      NodeFS.readFileSync(NodePath.join(fixture.destination, "new-user-work.ts"), "utf8"),
    ).toBe("preserve me\n");
  }).pipe(
    Effect.provide(recoveryGitLayer),
    Effect.provide(recoveryEventLayer),
    Effect.provide(h.layer),
  );
};
describe("MachineHandoff accepted-start recovery with real Git, store and event sink", () => {
  it.effect(
    "recovers the exact 1.0.13 approval prompt after accepted progress and a lost receipt",
    () => recoveryScenario("accepted", undefined, false, "approval"),
  );
  it.effect.each(["none", "rejected"] as const)(
    "does not redispatch the 1.0.13 approval prompt for %s without accepted proof",
    (kind) => recoveryScenario(kind, undefined, false, "approval"),
  );
  it.effect.each([
    "wrong-text",
    "wrong-thread",
    "wrong-message",
    "wrong-command",
    "wrong-author",
  ] as const)("rejects a mismatched %s acceptance of the 1.0.13 approval prompt", (kind) =>
    recoveryScenario(kind, undefined, false, "approval"),
  );
  it.effect.each(["prompt", "context", "workspace", "thread"] as const)(
    "refuses a changed %s binding after 1.0.13 approval-prompt acceptance",
    (binding) => recoveryScenario("accepted", binding, false, "approval"),
  );
  it.effect(
    "recovers an exact pre-upgrade launch prompt after accepted progress and a lost receipt",
    () => recoveryScenario("accepted", undefined, false, true),
  );
  it.effect("does not redispatch a legacy launch prompt without an accepted event", () =>
    recoveryScenario("none", undefined, false, true),
  );
  it.effect(
    "recovers older accepted-start records from local context with metadata-only preview",
    () => recoveryScenario("accepted", undefined, true),
  );
  it.effect(
    "recovers after accepted progress and a lost receipt before busy and dirty-workspace checks",
    () => recoveryScenario("accepted"),
  );
  it.effect.each([
    "none",
    "rejected",
    "wrong-text",
    "wrong-thread",
    "wrong-message",
    "wrong-command",
    "wrong-author",
  ] as const)("does not claim success for %s events", (kind) => recoveryScenario(kind));
  it.effect.each(["prompt", "context", "workspace", "thread"] as const)(
    "refuses a changed %s binding after acceptance",
    (binding) => recoveryScenario("accepted", binding),
  );
});

describe("exclusive logical coordinator transfer", () => {
  it.effect("fences before publication and never resumes source after an ambiguous failure", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = yield* service.prepare(preview);
      expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding).toBeUndefined();
      h.state.publicationFailure = true;
      const input = { ...preview, publish: true, expectedDigest: first.bundle.digest };
      expect((yield* failureOnly(service.prepare(input))).code).toBe("remote_unavailable");
      expect(h.state.publicationFenceStates).toEqual(["transferring"]);
      expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding?.state).toBe(
        "transferring",
      );
      expect(
        (yield* failureOnly(
          service.prepare({ ...preview, operationId: "22222222-2222-4222-8222-222222222222" }),
        )).code,
      ).toBe("conflict");
      h.state.publicationFailure = false;
      const published = yield* service.prepare(input);
      expect(published.bundle.logicalProject?.id).toBe(first.bundle.logicalProject?.id);
      expect(published.bundle.digest).not.toBe(first.bundle.digest);
      expect(published.bundle.coordinatorBinding?.state).toBe("transferring");
      expect(
        (yield* service.prepare({ ...input, expectedDigest: published.bundle.digest })).bundle,
      ).toEqual(published.bundle);
      const successor = published.bundle.coordinatorBinding!.successor!;
      expect(
        (yield* failureOnly(
          service.prepare({
            ...input,
            acknowledgment: {
              ...successor,
              environmentId: EnvironmentId.make("wrong-host"),
              operationId: id,
              digest: published.bundle.digest,
            },
          }),
        )).code,
      ).toBe("conflict");
      yield* service.prepare({
        ...input,
        acknowledgment: { ...successor, operationId: id, digest: published.bundle.digest },
      });
      expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding?.state).toBe(
        "transferred",
      );
      expect(h.state.pushes).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("refuses an unreleased bundle and a bundle bound to a different destination", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const valid = imported((yield* service.prepare(preview)).bundle);
      for (const change of [
        { coordinatorBinding: { ...valid.coordinatorBinding!, state: "active" as const } },
        { destination: { environmentId: EnvironmentId.make("third-host"), projectId } },
      ]) {
        const { digest: _digest, ...content } = { ...valid, ...change };
        const bundle = { ...content, digest: MachineHandoff.machineHandoffDigest(content) };
        expect(
          (yield* failureOnly(
            service.receive({ projectId, operationId: id, mode: "start", bundle }),
          )).code,
        ).toBe("invalid");
      }
      expect(h.state.starts).toEqual([]);
      expect(h.state.materializations).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "keeps domain identity and ancestry while activating only the next execution binding",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const bundle = imported((yield* service.prepare(preview)).bundle);
        const receipt = yield* service.receive({
          projectId,
          operationId: id,
          mode: "start",
          bundle,
        });
        const destination = h.projects.get(receipt.projectId)!;
        expect(destination.workspaceSettings?.logicalProject?.id).toBe(bundle.logicalProject!.id);
        expect(destination.workspaceSettings?.logicalProject?.members).toEqual(
          bundle.logicalProject!.members,
        );
        expect(destination.workspaceSettings?.coordinatorBinding).toMatchObject({
          state: "active",
          epoch: bundle.coordinatorBinding!.epoch + 1,
          predecessor: {
            environmentId: bundle.sourceEnvironmentId,
            projectId: bundle.sourceProjectId,
            coordinatorThreadId: bundle.sourceThreadId,
          },
        });
        expect(receipt.logicalProject?.id).toBe(bundle.logicalProject!.id);
        expect(receipt.environmentId).toBe("source-env");
      }).pipe(Effect.provide(h.layer));
    },
  );
});

it.effect(
  "joins only the explicitly accepted standalone destination and preserves its settings/history",
  () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      const current = h.projects.get(projectId)!;
      const targetIdentity = {
        id: "logical:target",
        title: "Existing",
        coordinatorId: "coordinator:target",
        members: [
          {
            environmentId: EnvironmentId.make("source-env"),
            projectId,
            coordinatorThreadId: threadId,
          },
        ],
      };
      h.projects.set(projectId, {
        ...current,
        workspaceSettings: {
          ...current.workspaceSettings!,
          logicalProject: targetIdentity,
          coordinatorBinding: { epoch: 0, state: "active" },
          goal: "Existing target intent",
        },
      });
      const rebind = (destination: MachineHandoffBundle["destination"]) => {
        const { digest: _digest, ...value } = { ...bundle, destination };
        return { ...value, digest: MachineHandoff.machineHandoffDigest(value) };
      };
      const receive = (value: MachineHandoffBundle) =>
        service.receive({ projectId, operationId: id, mode: "start", bundle: value });
      expect((yield* failureOnly(receive(bundle))).code).toBe("conflict");
      expect(
        (yield* failureOnly(
          receive(
            rebind({
              ...bundle.destination!,
              logicalProjectId: targetIdentity.id,
              joinExistingProject: false,
            }),
          ),
        )).code,
      ).toBe("conflict");
      expect(h.state.starts).toHaveLength(0);
      const accepted = rebind({
        ...bundle.destination!,
        logicalProjectId: targetIdentity.id,
        joinExistingProject: true,
      });
      const standalone = h.projects.get(projectId)!;
      h.projects.set(projectId, {
        ...standalone,
        workspaceSettings: {
          ...standalone.workspaceSettings!,
          logicalProject: {
            ...targetIdentity,
            members: [
              ...targetIdentity.members,
              {
                environmentId: EnvironmentId.make("other-target-host"),
                projectId: ProjectId.make("linked"),
                coordinatorThreadId: ThreadId.make("linked-coordinator"),
              },
            ],
          },
        },
      });
      expect((yield* failureOnly(receive(accepted))).code).toBe("conflict");
      expect(h.state.starts).toHaveLength(0);
      h.projects.set(projectId, standalone);
      const received = yield* receive(accepted);
      expect(h.projects.get(projectId)?.workspaceSettings).toMatchObject({
        goal: "Existing target intent",
        logicalProject: { id: bundle.logicalProject!.id },
        coordinatorBinding: { state: "transferred" },
      });
      expect(h.projects.get(received.projectId)?.workspaceSettings?.goal).toBe(bundle.context.goal);
      expect(h.projects.size).toBe(2);
    }).pipe(Effect.provide(h.layer));
  },
);
it.effect(
  "retains EasyChamp's name, earlier segments and identity on a second machine handoff",
  () => {
    const h = makeHarness();
    h.projects.set(projectId, { ...h.projects.get(projectId)!, title: "EasyChamp" });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = imported((yield* service.prepare(preview)).bundle);
      expect(first.logicalProject?.title).toBe("EasyChamp");
      const received = yield* service.receive({
        projectId,
        operationId: id,
        mode: "start",
        bundle: first,
      });
      expect(h.projects.get(received.projectId)?.title).toBe("EasyChamp");
      // A retained legacy operation label must not become the next domain name.
      h.projects.set(received.projectId, {
        ...h.projects.get(received.projectId)!,
        title: "sw-easychamp product handoff 0907",
      });
      const operationId = "22222222-2222-4222-8222-222222222222";
      const next = {
        projectId: received.projectId,
        operationId,
        publish: false,
        destination: {
          environmentId: EnvironmentId.make("third-env"),
          projectId: ProjectId.make("third-project"),
          joinExistingProject: true,
        },
      };
      const prepared = yield* service.prepare(next);
      expect(prepared.bundle.logicalProject?.id).toBe(first.logicalProject!.id);
      expect(prepared.bundle.logicalProject?.title).toBe("EasyChamp");
      expect(prepared.bundle.logicalProject?.members).toHaveLength(5);
      expect(prepared.bundle.context.threads.map((t) => [t.environmentId, t.projectId])).toEqual([
        ["other-env", projectId],
        ["source-env", received.projectId],
      ]);
      const published = yield* service.prepare({
        ...next,
        publish: true,
        expectedDigest: prepared.bundle.digest,
      });
      expect(published.bundle.coordinatorBinding).toMatchObject({
        epoch: 1,
        state: "transferring",
      });
      expect(h.projects.get(received.projectId)?.workspaceSettings?.coordinatorBinding?.state).toBe(
        "transferring",
      );
    }).pipe(Effect.provide(h.layer));
  },
);
