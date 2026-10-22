import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EventId,
  ProjectId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import { MCP_CLIENT_SUBJECT } from "../auth/EnvironmentAuth.ts";
import { planProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import { createdOrigin } from "./ProjectService.ts";
import {
  isTemporaryAgentSession,
  PROJECT_CLI_SESSION_LABEL,
  temporaryProjectsToDelete,
} from "./TemporaryProjects.ts";

const now = DateTime.makeUnsafe("2026-10-17T03:45:00.000Z");
const at = (iso: string) => DateTime.makeUnsafe(iso);

const client = (deviceType: string, label: string | null = null) =>
  ({
    label,
    ipAddress: null,
    userAgent: null,
    deviceType,
    os: null,
    browser: null,
  }) as never;

const project = (id: string, temporarySessionId?: string) => ({
  id: ProjectId.make(id),
  workspaceSettings: {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    ...(temporarySessionId === undefined ? {} : { temporarySessionId }),
  },
});

describe("isTemporaryAgentSession", () => {
  it("treats tokens a script issued from the CLI as temporary", () => {
    // The 1.0.40 provider proof that left "140 provider verification" projects.
    assert.isTrue(
      isTemporaryAgentSession({
        subject: "0889-provider-verification",
        client: client("bot", "140-provider-proof-a36d28e8"),
      }),
    );
  });

  it("keeps projects from the browser, the project CLI and MCP clients", () => {
    assert.isFalse(
      isTemporaryAgentSession({ subject: "one-time-token", client: client("desktop") }),
    );
    assert.isFalse(
      isTemporaryAgentSession({
        subject: "cli-issued-session",
        client: client("bot", PROJECT_CLI_SESSION_LABEL),
      }),
    );
    assert.isFalse(
      isTemporaryAgentSession({ subject: MCP_CLIENT_SUBJECT, client: client("bot", "Claude") }),
    );
  });
});

describe("temporaryProjectsToDelete", () => {
  type Ended = { expiresAt: DateTime.Utc; revokedAt: DateTime.Utc | null };
  const live: Ended = { expiresAt: at("2026-10-17T04:00:00.000Z"), revokedAt: null };
  const revoked = {
    expiresAt: at("2026-10-17T04:00:00.000Z"),
    revokedAt: at("2026-10-17T03:40:03.000Z"),
  };
  const expired = { expiresAt: at("2026-10-17T03:44:00.000Z"), revokedAt: null };

  it("deletes a proof project once its token is revoked, expired or gone", () => {
    const due = temporaryProjectsToDelete({
      projects: [
        project("revoked", "s-revoked"),
        project("expired", "s-expired"),
        project("gone", "s-gone"),
        project("live", "s-live"),
        project("user"),
      ],
      openThreads: [],
      sessions: new Map<string, Ended>([
        ["s-revoked", revoked],
        ["s-expired", expired],
        ["s-live", live],
      ]),
      now,
    });
    assert.deepEqual(
      due.map((p) => p.id),
      ["revoked", "expired", "gone"],
    );
  });

  it("keeps a temporary project while one of its threads is still open", () => {
    const due = temporaryProjectsToDelete({
      projects: [project("kept", "s-revoked")],
      openThreads: [{ projectId: ProjectId.make("kept") }],
      sessions: new Map([["s-revoked", revoked]]),
      now,
    });
    assert.deepEqual(due, []);
  });
});

describe("project.create", () => {
  it("records the temporary session on the new project", () => {
    const result = planProjectCommand({
      command: {
        type: "project.create",
        commandId: CommandId.make("cmd-create"),
        projectId: ProjectId.make("proof"),
        title: "141 provider verification copilot-0889",
        workspaceRoot: "/tmp/proof",
        temporarySessionId: "s-proof",
      },
      state: { project: undefined, workspaceOwner: undefined },
      eventId: EventId.make("event:planned"),
      now,
    });
    assert.isTrue(Result.isSuccess(result));
    const payload = Result.getOrThrow(result).payload as {
      workspaceSettings: { temporarySessionId?: string };
    };
    assert.equal(payload.workspaceSettings.temporarySessionId, "s-proof");
  });
});

describe("project origin", () => {
  it("records an origin on the new project", () => {
    const result = planProjectCommand({
      command: {
        type: "project.create",
        commandId: CommandId.make("cmd-create-origin"),
        projectId: ProjectId.make("check"),
        title: "Run shell acceptance 357",
        workspaceRoot: "/Users/x/.specwithcode/m4/scratch/run-shell/workspace",
        origin: "automated",
      },
      state: { project: undefined, workspaceOwner: undefined },
      eventId: EventId.make("event:planned-origin"),
      now,
    });
    assert.isTrue(Result.isSuccess(result));
    const payload = Result.getOrThrow(result).payload as {
      workspaceSettings: { origin?: string };
    };
    assert.equal(payload.workspaceSettings.origin, "automated");
  });

  it("saves an origin only when the creator gives one or a temporary token makes it", () => {
    assert.deepStrictEqual(createdOrigin({ origin: "automated" }), { origin: "automated" });
    assert.deepStrictEqual(createdOrigin({ temporarySessionId: "s" }), { origin: "automated" });
    // A folder that looks like a check's is judged when shown, never saved.
    assert.deepStrictEqual(createdOrigin({}), {});
  });

  it("never deletes a temporary project the person moved to their own", () => {
    const due = temporaryProjectsToDelete({
      projects: [
        {
          id: ProjectId.make("kept"),
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            temporarySessionId: "s-gone",
            origin: "user",
          },
        },
      ],
      openThreads: [],
      sessions: new Map(),
      now,
    });
    assert.deepStrictEqual(due, []);
  });
});
