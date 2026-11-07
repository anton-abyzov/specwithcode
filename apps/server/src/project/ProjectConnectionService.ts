import {
  teamRulesConnectionAllowsAny,
  teamRulesConnectionRefusal,
} from "@specweave-studio/shared/teamRules";
import { currentTeamRules, teamRulesForFolder } from "../teamRules/TeamRules.ts";
import { parseJson, stringifyJson } from "../json.ts";
import * as DateTime from "effect/DateTime";
import {
  NativeConnectionsError,
  type NativeConnectionApplyInput,
  type NativeConnectionsInput,
  type NativeConnectionsSnapshot,
} from "@specweave-studio/contracts";
import * as NativeDiscovery from "./connections/NativeConnectionDiscovery.ts";
import {
  type ProjectId,
  type ProjectConnection,
  type ProjectConnectionConfig,
  type ProjectConnectionActionInput,
  type ProjectConnectionSaveInput,
  type ProjectConnectionCallInput,
  type ProjectConnectionCallResult,
  type ProjectConnectionCredentialInput,
  ProjectConnectionError,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Transport from "./connections/ProjectConnectionTransport.ts";
import { connectionFingerprint, validConnectionConfig } from "./connections/config.ts";

const CREDENTIAL_INDEX = "project-connection-index";

export class ProjectConnectionService extends Context.Service<
  ProjectConnectionService,
  {
    discoverNative: (
      input: NativeConnectionsInput,
    ) => Effect.Effect<NativeConnectionsSnapshot, NativeConnectionsError>;
    applyNative: (
      input: NativeConnectionApplyInput,
    ) => Effect.Effect<NativeConnectionsSnapshot, NativeConnectionsError>;
    read: (input: {
      projectId: ProjectId;
    }) => Effect.Effect<{ connections: readonly ProjectConnection[] }, ProjectConnectionError>;
    save: (
      input: ProjectConnectionSaveInput,
    ) => Effect.Effect<ProjectConnection, ProjectConnectionError>;
    check: (
      input: ProjectConnectionActionInput,
    ) => Effect.Effect<ProjectConnection, ProjectConnectionError>;
    revoke: (
      input: ProjectConnectionActionInput,
    ) => Effect.Effect<ProjectConnection, ProjectConnectionError>;
    setCredential: (
      input: ProjectConnectionCredentialInput,
    ) => Effect.Effect<ProjectConnection, ProjectConnectionError>;
    call: (
      input: ProjectConnectionCallInput & { actor: string },
    ) => Effect.Effect<ProjectConnectionCallResult, ProjectConnectionError>;
  }
>()("specweave-studio/project/ProjectConnectionService") {}
const make = Effect.gen(function* () {
  const discovery = yield* NativeDiscovery.NativeConnectionDiscovery;
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const transport = yield* Transport.ProjectConnectionTransport;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  // Hashed: one project's token is out of reach of any other project's connection.
  const credentialName = (projectId: ProjectId, id: string, key: string) =>
    `project-connection-${connectionFingerprint([projectId, id, key])}`;
  const removeCredentials = (projectId: ProjectId, value: ProjectConnection) =>
    Effect.forEach(
      value.envKeys,
      (key) => secrets.remove(credentialName(projectId, value.id, key)),
      { discard: true },
    );
  // Hashed names cannot be listed back, so this remembers which project wrote each one.
  const indexLock = yield* Semaphore.make(1);
  const readIndex = secrets
    .get(CREDENTIAL_INDEX)
    .pipe(
      Effect.flatMap((bytes) =>
        Option.isSome(bytes)
          ? Effect.try(
              () => parseJson(new TextDecoder().decode(bytes.value)) as Record<string, string>,
            ).pipe(Effect.orElseSucceed((): Record<string, string> => ({})))
          : Effect.succeed<Record<string, string>>({}),
      ),
    );
  const writeIndex = (index: Record<string, string>) =>
    secrets.set(CREDENTIAL_INDEX, new TextEncoder().encode(stringifyJson(index)));
  // A deleted project's tokens go at the next start, whichever path deleted it. Never blocks one.
  yield* indexLock
    .withPermit(
      Effect.gen(function* () {
        const index = yield* readIndex;
        const kept: Record<string, string> = {};
        for (const [name, projectId] of Object.entries(index)) {
          const found = yield* projects.get(projectId as ProjectId);
          if (Option.isSome(found)) kept[name] = projectId;
          else yield* secrets.remove(name);
        }
        if (Object.keys(kept).length !== Object.keys(index).length) yield* writeIndex(kept);
      }),
    )
    .pipe(Effect.catchCause(() => Effect.void));
  const storedCredentials = (projectId: ProjectId, value: ProjectConnection) =>
    Effect.gen(function* () {
      const stored: Record<string, string> = {};
      for (const key of value.envKeys) {
        const bytes = yield* secrets.get(credentialName(projectId, value.id, key));
        if (Option.isSome(bytes)) stored[key] = new TextDecoder().decode(bytes.value);
      }
      return stored;
    });
  const error = (projectId: ProjectId, code: ProjectConnectionError["code"]) =>
    new ProjectConnectionError({ projectId, code });
  const safe = (projectId: ProjectId) =>
    Effect.mapError((cause: unknown) =>
      Schema.is(ProjectConnectionError)(cause) ? cause : error(projectId, "operation_failed"),
    );
  const project = (projectId: ProjectId, active = false) =>
    projects.get(projectId).pipe(
      Effect.flatMap((p) => {
        if (Option.isNone(p)) return Effect.fail(error(projectId, "not_found"));
        if (active && (p.value.workspaceSettings?.paused || p.value.workspaceSettings?.archived))
          return Effect.fail(error(projectId, "denied"));
        return Effect.succeed(p.value);
      }),
    );
  const rows = (projectId: ProjectId) =>
    sql<{
      data: string;
    }>`SELECT data_json AS data FROM project_connections WHERE project_id=${projectId} ORDER BY connection_id`.pipe(
      Effect.map((rows) => rows.map((row) => parseJson(row.data) as ProjectConnection)),
    );
  const connection = (input: ProjectConnectionActionInput) =>
    Effect.gen(function* () {
      const value = (yield* rows(input.projectId)).find((row) => row.id === input.id);
      if (!value) return yield* error(input.projectId, "not_found");
      if (value.revision !== input.expectedRevision)
        return yield* error(input.projectId, "conflict");
      return value;
    });
  const persist = (projectId: ProjectId, value: ProjectConnection) =>
    sql`INSERT INTO project_connections (project_id,connection_id,revision,data_json) VALUES (${projectId},${value.id},${value.revision},${stringifyJson(value)}) ON CONFLICT(project_id,connection_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json`.pipe(
      Effect.as(value),
    );
  const configOf = ({
    name,
    command,
    args,
    envKeys,
  }: ProjectConnection): ProjectConnectionConfig => ({ name, command, args, envKeys });
  const read = (input: { projectId: ProjectId }) =>
    Effect.gen(function* () {
      yield* project(input.projectId);
      return { connections: yield* rows(input.projectId) };
    }).pipe(safe(input.projectId));
  // Reading and revoking stay available, so a person can see and remove what the rules refuse.
  const refuseByTeamRules = (
    projectId: ProjectId,
    workspaceRoot: string,
    names: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const rules = yield* teamRulesForFolder(workspaceRoot);
      const refused = rules.status === "none" ? null : teamRulesConnectionRefusal(rules, names);
      if (refused !== null) {
        return yield* new ProjectConnectionError({
          projectId,
          code: "denied",
          teamRulesMessage: refused.message,
        });
      }
    });
  const save = (input: ProjectConnectionSaveInput) =>
    admission
      .withLock(
        input.projectId,
        // Reading the rules can run Git, so it stays out of the transaction.
        project(input.projectId).pipe(
          Effect.flatMap((target) =>
            refuseByTeamRules(input.projectId, target.workspaceRoot, [input.config.name]),
          ),
          Effect.andThen(
            sql.withTransaction(
              Effect.gen(function* () {
                const target = yield* project(input.projectId);
                if (
                  !validConnectionConfig(input.config) ||
                  !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)
                )
                  return yield* error(input.projectId, "invalid");
                const all = yield* rows(input.projectId);
                const previous = all.find((c) => c.id === input.id);
                if ((previous?.revision ?? null) !== input.expectedRevision)
                  return yield* error(input.projectId, "conflict");
                if (!previous && all.length >= 32) return yield* error(input.projectId, "invalid");
                const unchanged =
                  previous &&
                  previous.status !== "revoked" &&
                  connectionFingerprint(configOf(previous)) === connectionFingerprint(input.config);
                const tools = unchanged ? previous.tools : [];
                const allowedTools = [...new Set(input.allowedTools)];
                if (
                  allowedTools.some((name) => !tools.some((tool) => tool.name === name)) ||
                  (allowedTools.length > 0 && previous?.status !== "ready")
                )
                  return yield* error(input.projectId, "denied");
                // A token was given to one command; a different command must never receive it.
                if (previous && !unchanged) yield* removeCredentials(input.projectId, previous);
                return yield* persist(input.projectId, {
                  id: input.id,
                  ...input.config,
                  revision: (previous?.revision ?? 0) + 1,
                  status: unchanged ? previous.status : "configured",
                  checkedAt: unchanged ? previous.checkedAt : null,
                  tools,
                  allowedTools,
                });
              }),
            ),
          ),
        ),
      )
      .pipe(safe(input.projectId));
  const check = (input: ProjectConnectionActionInput) =>
    Effect.gen(function* () {
      const target = yield* project(input.projectId, true);
      const initial = yield* connection(input);
      if (initial.status === "revoked") return yield* error(input.projectId, "denied");
      yield* refuseByTeamRules(input.projectId, target.workspaceRoot, [initial.name]);
      const stored = yield* storedCredentials(input.projectId, initial);
      const discovered = yield* transport
        .discover({ config: configOf(initial), cwd: target.workspaceRoot, stored })
        .pipe(Effect.option);
      return yield* admission.withLock(
        input.projectId,
        sql.withTransaction(
          Effect.gen(function* () {
            yield* project(input.projectId, true);
            const current = yield* connection(input);
            const tools = Option.getOrElse(discovered, () => []);
            const same = connectionFingerprint(current.tools) === connectionFingerprint(tools);
            return yield* persist(input.projectId, {
              ...current,
              revision: current.revision + 1,
              checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
              status: Option.isSome(discovered) ? "ready" : "unavailable",
              tools,
              allowedTools: same && Option.isSome(discovered) ? current.allowedTools : [],
            });
          }),
        ),
      );
    }).pipe(safe(input.projectId));
  const revoke = (input: ProjectConnectionActionInput) =>
    admission
      .withLock(
        input.projectId,
        sql.withTransaction(
          Effect.gen(function* () {
            yield* project(input.projectId);
            const current = yield* connection(input);
            yield* removeCredentials(input.projectId, current);
            return yield* persist(input.projectId, {
              ...current,
              revision: current.revision + 1,
              status: "revoked",
              tools: [],
              allowedTools: [],
            });
          }),
        ),
      )
      .pipe(safe(input.projectId));
  const setCredential = (input: ProjectConnectionCredentialInput) =>
    admission
      .withLock(
        input.projectId,
        Effect.gen(function* () {
          yield* project(input.projectId);
          const current = yield* connection(input);
          if (current.status === "revoked" || !current.envKeys.includes(input.envKey))
            return yield* error(input.projectId, "denied");
          const name = credentialName(input.projectId, current.id, input.envKey);
          yield* indexLock.withPermit(
            readIndex.pipe(
              Effect.flatMap((index) => writeIndex({ ...index, [name]: input.projectId })),
            ),
          );
          yield* secrets.set(name, new TextEncoder().encode(input.value));
          // Another token can mean another account: tools and grants need a new check.
          return yield* persist(input.projectId, {
            ...current,
            revision: current.revision + 1,
            status: "configured",
            checkedAt: null,
            tools: [],
            allowedTools: [],
          });
        }),
      )
      .pipe(safe(input.projectId));
  const call = (input: ProjectConnectionCallInput & { actor: string }) =>
    admission
      .withLock(
        input.projectId,
        Effect.gen(function* () {
          const target = yield* project(input.projectId, true);
          const current = yield* connection(input);
          yield* refuseByTeamRules(input.projectId, target.workspaceRoot, [current.name]);
          const tool = current.tools.find((t) => t.name === input.tool);
          if (current.status !== "ready" || !tool || !current.allowedTools.includes(input.tool))
            return yield* error(input.projectId, "denied");
          if (stringifyJson(input.arguments).length > 65_536)
            return yield* error(input.projectId, "invalid");
          const fingerprint = connectionFingerprint(input);
          const receipts = yield* sql<{
            fingerprint: string;
            result: string | null;
          }>`SELECT fingerprint,result_json AS result FROM project_connection_calls WHERE project_id=${input.projectId} AND command_id=${input.commandId}`;
          const receipt = receipts[0];
          if (receipt) {
            if (receipt.fingerprint !== fingerprint)
              return yield* error(input.projectId, "conflict");
            if (receipt.result === null) return yield* error(input.projectId, "outcome_unknown");
            return parseJson(receipt.result) as ProjectConnectionCallResult;
          }
          const stored = yield* storedCredentials(input.projectId, current);
          yield* sql`INSERT INTO project_connection_calls (project_id,command_id,fingerprint) VALUES (${input.projectId},${input.commandId},${fingerprint})`;
          const result = yield* transport
            .call({
              config: configOf(current),
              cwd: target.workspaceRoot,
              stored,
              tool,
              arguments: input.arguments,
            })
            .pipe(
              Effect.mapError((failure) =>
                error(
                  input.projectId,
                  failure.reason === "changed" ? "changed" : "outcome_unknown",
                ),
              ),
            );
          yield* sql`UPDATE project_connection_calls SET result_json=${stringifyJson(result)} WHERE project_id=${input.projectId} AND command_id=${input.commandId}`.pipe(
            Effect.mapError(() => error(input.projectId, "outcome_unknown")),
          );
          return result;
        }),
      )
      .pipe(safe(input.projectId));
  const discoverNative = (input: NativeConnectionsInput) =>
    Effect.gen(function* () {
      if (!input.projectId) return yield* discovery.read();
      const target = yield* projects
        .get(input.projectId)
        .pipe(Effect.mapError(() => new NativeConnectionsError({ code: "unavailable" })));
      if (Option.isNone(target))
        return yield* new NativeConnectionsError({ code: "project_not_found" });
      return yield* discovery.read(target.value.workspaceRoot);
    });
  return ProjectConnectionService.of({
    read,
    save,
    check,
    revoke,
    setCredential,
    call,
    discoverNative,
    applyNative: (input) =>
      Effect.gen(function* () {
        const rules = yield* currentTeamRules;
        if (rules.status === "none") return yield* discovery.apply(input);
        // Turning one off or removing it stays available; anything that can turn one on is judged.
        const named = (name: string | undefined) => teamRulesConnectionRefusal(rules, [name ?? ""]);
        let refused = null;
        if (input.action === "add") refused = named(input.name);
        if (input.action === "enable" || input.action === "copy") {
          const connections = (yield* discovery.read()).connections;
          refused = named(connections.find((row) => row.id === input.connectionId)?.name);
        }
        if (input.action === "plugin" && input.enabled === true) refused = named(input.pluginKey);
        if (input.action === "copyAll" || input.action === "undo") {
          refused = teamRulesConnectionAllowsAny(rules) ? null : named(undefined);
        }
        if (refused !== null) {
          return yield* new NativeConnectionsError({
            code: "unsupported",
            teamRulesMessage: refused.message,
          });
        }
        return yield* discovery.apply(input);
      }),
  });
});
export const layerWithDiscovery = Layer.effect(ProjectConnectionService, make).pipe(
  Layer.provide(ProjectAdmission.layer),
);

export const layer = layerWithDiscovery.pipe(Layer.provide(NativeDiscovery.layerHost));
