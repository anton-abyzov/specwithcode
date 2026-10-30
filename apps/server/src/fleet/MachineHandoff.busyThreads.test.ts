import { describe, expect, it } from "@effect/vitest";
import { MACHINE_HANDOFF_MAX_BUSY_THREADS, MachineHandoffError } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { ACTIVE_COPY_WARNING, busyCopyWarnings } from "./folderCopyPreparation.ts";
import { busyHandoffError } from "./handoffBusyThreads.ts";
import * as MachineHandoff from "./MachineHandoff.ts";
import { makeHarness, preview } from "./MachineHandoff.test-fixtures.ts";

const failureOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return result.failure;
      throw new Error("Expected request to fail");
    }),
  );

const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, "0")}:00Z`;

/** A thread of the umbrella project, owned by another registration on the same folder. */
const thread = (sql: SqlClient.SqlClient, id: string, title: string, minute: number) =>
  sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${id},'umbrella',${title},'codex','full-access','default',${at(minute)},${at(minute)},'{}')`;

const question = (sql: SqlClient.SqlClient, threadId: string, kind = "user_input") =>
  sql`INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES (${`request-${threadId}`},${threadId},'node',${kind},'pending',${at(0)},'{}')`;

describe("MachineHandoff busy refusals name the threads", () => {
  it.effect("lists old workers waiting for an answer, with no run running", () => {
    const h = makeHarness({ realDatabase: true });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('umbrella','specweave umbrella','/source/project','[]',${at(0)},${at(0)})`;
      yield* thread(sql, "lanes", "1050 repair lanes C and D", 1);
      yield* thread(sql, "review", "1048 fresh review r2", 2);
      yield* thread(sql, "idle", "Finished long ago", 3);
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('done','lanes',1,'codex','completed',${at(1)},'{}')`;
      yield* question(sql, "lanes");
      yield* question(sql, "review");

      const failure = yield* failureOnly(service.prepare(preview));
      expect(failure).toBeInstanceOf(MachineHandoffError);
      expect(failure.code).toBe("busy");
      const busy = (failure as MachineHandoffError).busy;
      expect(busy).toEqual({
        total: 2,
        threads: [
          {
            threadId: "review",
            title: "1048 fresh review r2",
            projectId: "umbrella",
            projectTitle: "specweave umbrella",
            reason: "waiting_for_answer",
          },
          {
            threadId: "lanes",
            title: "1050 repair lanes C and D",
            projectId: "umbrella",
            projectTitle: "specweave umbrella",
            reason: "waiting_for_answer",
          },
        ],
      });
      expect(failure.message).toContain("2 threads are still working or waiting for you");
      expect(h.state.pushes).toBe(0);

      // Answering both questions lets the move go ahead.
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status='resolved'`;
      expect((yield* service.prepare(preview)).publication).toBe("unpublished");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "names each reason: running, sign-in, approval, provider session and pending effect",
    () => {
      const h = makeHarness({ realDatabase: true });
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('umbrella','Umbrella','/source/project/nested','[]',${at(0)},${at(0)})`;
        yield* thread(sql, "signin", "Sign in", 6);
        yield* thread(sql, "tool", "Tool call", 5);
        yield* thread(sql, "run", "Running", 4);
        yield* thread(sql, "approve", "Approval", 3);
        yield* thread(sql, "session", "Session", 2);
        yield* thread(sql, "effect", "Effect", 1);
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('r','run',1,'codex','running',${at(4)},'{}')`;
        yield* question(sql, "approve", "command_execution");
        yield* question(sql, "signin", "auth_refresh");
        // The app answers a dynamic tool call itself: nobody approves it, it is running work.
        yield* question(sql, "tool", "dynamic_tool_call");
        yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES ('s','session','codex','running',${at(2)},'{}')`;
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at) VALUES ('e','c','effect','provider-turn.start','{}','pending',0,${at(1)},${at(1)},${at(1)})`;
        const failure = (yield* failureOnly(service.prepare(preview))) as MachineHandoffError;
        expect(failure.busy?.threads.map((t) => [t.threadId, t.reason])).toEqual([
          ["signin", "waiting_for_sign_in"],
          ["tool", "running"],
          ["run", "running"],
          ["approve", "pending_approval"],
          ["session", "provider_session"],
          ["effect", "pending_effect"],
        ]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("caps the list and keeps the total", () => {
    const h = makeHarness({ realDatabase: true });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('umbrella','Umbrella','/source/project','[]',${at(0)},${at(0)})`;
      for (let index = 0; index < 13; index++) {
        yield* thread(sql, `t${index}`, `Thread ${index}`, index);
        yield* question(sql, `t${index}`);
      }
      const failure = (yield* failureOnly(service.prepare(preview))) as MachineHandoffError;
      expect(failure.busy?.total).toBe(13);
      expect(failure.busy?.threads).toHaveLength(MACHINE_HANDOFF_MAX_BUSY_THREADS);
      expect(failure.busy?.threads[0]?.threadId).toBe("t12");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("names the retained chat that is still streaming", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      h.state.streaming = true;
      const failure = (yield* failureOnly(service.prepare(preview))) as MachineHandoffError;
      expect(failure.code).toBe("busy");
      expect(failure.busy).toMatchObject({
        total: 1,
        threads: [{ title: "Coordinator", projectTitle: "Project", reason: "running" }],
      });
      h.state.streaming = false;
      expect((yield* service.prepare(preview)).publication).toBe("unpublished");
    }).pipe(Effect.provide(h.layer));
  });

  it("lists each thread once and keeps the plain refusal without any", () => {
    const row = { threadId: "a", title: "  ", projectId: "p", reason: "running" as const };
    const error = busyHandoffError([row, { ...row, reason: "pending_effect" }]);
    expect(error.busy).toEqual({
      total: 1,
      threads: [{ threadId: "a", title: "Untitled thread", projectId: "p", reason: "running" }],
    });
    expect(error.message).toContain("A thread is still working");
    const plain = busyHandoffError([]);
    expect(plain.busy).toBeUndefined();
    expect(plain.message).toBe("Finish active work in this project before handing it off.");
  });

  it("names waiting threads on the copy step instead of saying work is running", () => {
    const row = (threadId: string, reason: "waiting_for_answer" | "running") => ({
      threadId,
      title: `Thread ${threadId}`,
      projectId: "p",
      reason,
    });
    // The live case: two workers wait for an answer and nothing runs.
    expect(
      busyCopyWarnings(
        busyHandoffError([row("a", "waiting_for_answer"), row("b", "waiting_for_answer")]),
      ),
    ).toEqual([
      '2 threads here are waiting for you: "Thread a", "Thread b". They don\'t stop on their own: answer or close what each one asks before the coordinator moves.',
    ]);
    // Running work still stops on its own; a waiting one beside it is named.
    expect(
      busyCopyWarnings(busyHandoffError([row("r", "running"), row("a", "waiting_for_answer")])),
    ).toEqual([
      ACTIVE_COPY_WARNING,
      'A thread here is waiting for you: "Thread a". It doesn\'t stop on its own: answer or close what it asks before the coordinator moves.',
    ]);
    expect(busyCopyWarnings(busyHandoffError([row("r", "running")]))).toEqual([
      ACTIVE_COPY_WARNING,
    ]);
    expect(busyCopyWarnings(new MachineHandoffError({ code: "busy" }))).toEqual([
      ACTIVE_COPY_WARNING,
    ]);
    const many = Array.from({ length: 12 }, (_, index) => row(`t${index}`, "waiting_for_answer"));
    const [capped] = busyCopyWarnings(busyHandoffError(many));
    expect(capped).toMatch(
      /^10 threads here are waiting for you: .* and 5 more\. .* 2 more threads are busy too\.$/,
    );
  });
});
