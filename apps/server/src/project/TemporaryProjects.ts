import {
  AuthSessionId,
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { MCP_CLIENT_SUBJECT } from "../auth/EnvironmentAuth.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectService from "./ProjectService.ts";

/**
 * Projects made by scripts and agents through `specweave-studio auth session issue`
 * tokens (release checks, provider proofs) are temporary: the project remembers the
 * session, and once that session is revoked or expires the server deletes the
 * project. Without this, every verification run left a project in the sidebar.
 */

/** The `project` CLI's own session: it adds real projects on the user's request. */
export const PROJECT_CLI_SESSION_LABEL = "specweave-studio project cli";

type SessionRecord = Pick<
  AuthSessions.AuthSessionRecord,
  "subject" | "client" | "expiresAt" | "revokedAt"
>;

/** A short-lived bearer token issued to a script or agent from the CLI. */
export function isTemporaryAgentSession(session: Pick<SessionRecord, "subject" | "client">) {
  return (
    session.client.deviceType === "bot" &&
    session.subject !== MCP_CLIENT_SUBJECT &&
    session.client.label !== PROJECT_CLI_SESSION_LABEL
  );
}

/** The session id to record on a project the given session creates, if temporary. */
export const temporarySessionIdFor = Effect.fn("TemporaryProjects.temporarySessionIdFor")(
  function* (sessionId: string) {
    const sessions = yield* AuthSessions.AuthSessionRepository;
    const session = yield* sessions.getById({ sessionId: AuthSessionId.make(sessionId) });
    return Option.isSome(session) && isTemporaryAgentSession(session.value) ? sessionId : undefined;
  },
  (effect) =>
    effect.pipe(
      Effect.provide(AuthSessions.layer),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not read the creating session", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    ),
);

/**
 * Temporary projects to delete now: their session has ended (revoked, expired or
 * gone) and none of their threads is still open. A thread someone kept open
 * keeps the project; it stays until that thread is archived.
 */
export function temporaryProjectsToDelete<
  P extends Pick<OrchestrationProjectShell, "id" | "workspaceSettings">,
>(input: {
  readonly projects: ReadonlyArray<P>;
  readonly openThreads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "projectId">>;
  readonly sessions: ReadonlyMap<string, Pick<SessionRecord, "expiresAt" | "revokedAt">>;
  readonly now: DateTime.Utc;
}) {
  const busy = new Set(input.openThreads.map((thread) => thread.projectId));
  return input.projects.filter((project) => {
    const sessionId = project.workspaceSettings?.temporarySessionId;
    if (sessionId === undefined || busy.has(project.id)) return false;
    const session = input.sessions.get(sessionId);
    return (
      session === undefined ||
      session.revokedAt !== null ||
      DateTime.toEpochMillis(session.expiresAt) <= DateTime.toEpochMillis(input.now)
    );
  });
}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const crypto = yield* Crypto.Crypto;

  const sweep = Effect.fn("TemporaryProjects.sweep")(function* () {
    const temporary = (yield* projects.listShells()).filter(
      (project) => project.workspaceSettings?.temporarySessionId !== undefined,
    );
    if (temporary.length === 0) return 0;
    const records = new Map<string, Pick<SessionRecord, "expiresAt" | "revokedAt">>();
    for (const project of temporary) {
      const sessionId = project.workspaceSettings!.temporarySessionId!;
      const record = yield* sessions.getById({ sessionId: AuthSessionId.make(sessionId) });
      if (Option.isSome(record)) records.set(sessionId, record.value);
    }
    const snapshot = yield* projections.getShellSnapshot({ location: "active" });
    const due = temporaryProjectsToDelete({
      projects: temporary,
      openThreads: snapshot.threads,
      sessions: records,
      now: yield* DateTime.now,
    });
    let deleted = 0;
    for (const project of due) {
      const removed = yield* projects
        .delete({
          commandId: CommandId.make(
            `server:temporary-project:${project.id}:${yield* crypto.randomUUIDv4}`,
          ),
          projectId: project.id,
          force: true,
          confirmationTitle: project.title,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not delete a temporary project", {
              projectId: project.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      if (!removed) continue;
      deleted += 1;
      yield* Effect.logInfo("Deleted a temporary project after its session ended", {
        projectId: project.id,
        title: project.title,
      });
    }
    return deleted;
  });

  const start = (): Effect.Effect<void, never, Scope.Scope> =>
    forkParked(
      sweep().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Temporary project sweep failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced("1 minute")),
        Effect.asVoid,
      ),
    );

  return { start, sweep };
});
