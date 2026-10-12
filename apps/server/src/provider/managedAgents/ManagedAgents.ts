import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  MANAGED_AGENTS_BETA,
  buildManagedAgentsSystem,
  type ManagedAgentsConfig,
} from "./config.ts";
import {
  createManagedSseDecoder,
  emptyManagedWorkflowState,
  reduceManagedWorkflowEvent,
  type ManagedWorkflowState,
} from "./state.ts";

export class ManagedAgentsUnavailableError extends Schema.TaggedError<ManagedAgentsUnavailableError>()(
  "ManagedAgentsUnavailableError",
  { reason: Schema.Literals(["disabled", "beta_opt_in_required", "api_key_missing"]) },
) {
  override get message(): string {
    return this.reason === "api_key_missing"
      ? "Managed Agents beta requires ANTHROPIC_API_KEY. A Claude Code subscription login is not API authentication."
      : this.reason === "beta_opt_in_required"
        ? "Managed Agents beta requires an explicit --beta opt-in for this run."
        : "Managed Agents beta is disabled in its configuration.";
  }
}
export class ManagedAgentsRequestError extends Schema.TaggedError<ManagedAgentsRequestError>()(
  "ManagedAgentsRequestError",
  {
    operation: Schema.String,
    category: Schema.Literals([
      "authentication",
      "permission",
      "billing",
      "rate_limit",
      "http",
      "transport",
      "protocol",
      "timeout",
    ]),
    status: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.category === "billing"
      ? "Managed Agents requires a funded Anthropic API account. This API credential has insufficient credit."
      : `Managed Agents ${this.operation} failed (${this.category}${this.status ? `, HTTP ${this.status}` : ""}).`;
  }
}
export class ManagedAgentsInputError extends Schema.TaggedError<ManagedAgentsInputError>()(
  "ManagedAgentsInputError",
  { field: Schema.String },
) {
  override get message(): string {
    return `Managed Agents input is invalid: ${this.field}.`;
  }
}
export class ManagedAgentsCredentials extends Context.Service<
  ManagedAgentsCredentials,
  { readonly apiKey: Redacted.Redacted<string> | undefined }
>()("specweave-studio/provider/managedAgents/ManagedAgents/ManagedAgentsCredentials") {}

export interface ManagedThreadEvidence {
  readonly id: string;
  readonly workflowRunId: string | null;
  readonly messages: readonly string[];
  readonly reportMessages: readonly string[];
  readonly agentId: string | null;
  readonly instructionsMatch: boolean;
  readonly usage: unknown;
  readonly failed: boolean;
}
export interface ManagedAgentsReceipt {
  readonly sessionId: string;
  readonly workerId: string;
  readonly leadId: string;
  readonly state: ManagedWorkflowState;
  readonly executionComplete: boolean;
  readonly verified: false;
  readonly threadEvidence: readonly ManagedThreadEvidence[];
  readonly evidenceComplete: boolean;
  readonly usage: unknown;
  readonly cleanupFailures: readonly string[];
}
export class ManagedAgents extends Context.Service<
  ManagedAgents,
  {
    readonly status: (config?: ManagedAgentsConfig) => Effect.Effect<{
      readonly configured: boolean;
      readonly apiKeyPresent: boolean;
      readonly authentication: "anthropic-api-key";
      readonly beta: string;
      readonly reason: "ready" | "disabled" | "api_key_missing";
    }>;
    readonly run: (input: {
      readonly config: ManagedAgentsConfig;
      readonly betaOptIn: boolean;
      readonly prompt: string;
      readonly sharedInstructions: string;
      readonly onProgress?: (state: ManagedWorkflowState) => void;
      readonly onResourceCreated?: (path: string) => void;
      readonly onResourceArchived?: (path: string, success: boolean) => void;
    }) => Effect.Effect<
      ManagedAgentsReceipt,
      ManagedAgentsUnavailableError | ManagedAgentsRequestError | ManagedAgentsInputError
    >;
  }
>()("specweave-studio/provider/managedAgents/ManagedAgents") {}

const isRequestError = Schema.is(ManagedAgentsRequestError);
const isUnavailableError = Schema.is(ManagedAgentsUnavailableError);

const Resource = Schema.Struct({ id: Schema.String, version: Schema.optionalKey(Schema.Number) });
const decodeResource = Schema.decodeUnknownEffect(Resource);
const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? (input as Record<string, unknown>) : {};
const idField = (input: unknown): string => (typeof input === "string" ? input : "");

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const credentials = yield* ManagedAgentsCredentials;
  const status: ManagedAgents["Service"]["status"] = (config) =>
    Effect.succeed({
      configured: !!config?.enabled,
      apiKeyPresent: !!credentials.apiKey,
      authentication: "anthropic-api-key",
      beta: MANAGED_AGENTS_BETA,
      reason: !config?.enabled ? "disabled" : !credentials.apiKey ? "api_key_missing" : "ready",
    });

  const request = (operation: string, method: "GET" | "POST", path: string, body?: unknown) =>
    Effect.gen(function* () {
      const key = credentials.apiKey;
      if (!key) return yield* new ManagedAgentsUnavailableError({ reason: "api_key_missing" });
      const base = HttpClientRequest.make(method)(`https://api.anthropic.com/v1/${path}`).pipe(
        HttpClientRequest.setHeaders({
          "x-api-key": Redacted.value(key),
          "anthropic-version": "2023-06-01",
          "anthropic-beta": MANAGED_AGENTS_BETA,
        }),
      );
      const response = yield* client
        .execute(body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
        .pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              Effect.fail(
                new ManagedAgentsRequestError({
                  operation,
                  category: "timeout",
                  status: 0,
                  cause: undefined,
                }),
              ),
          }),
          Effect.mapError((cause) =>
            isRequestError(cause)
              ? cause
              : new ManagedAgentsRequestError({
                  operation,
                  category: "transport",
                  status: 0,
                  cause,
                }),
          ),
        );
      if (response.status < 200 || response.status >= 300) {
        const errorBody = yield* response.json.pipe(Effect.catch(() => Effect.succeed(null)));
        const apiMessage = record(record(errorBody).error).message;
        return yield* new ManagedAgentsRequestError({
          operation,
          status: response.status,
          category:
            response.status === 400 &&
            typeof apiMessage === "string" &&
            apiMessage.includes("credit balance")
              ? "billing"
              : response.status === 401
                ? "authentication"
                : response.status === 403
                  ? "permission"
                  : response.status === 429
                    ? "rate_limit"
                    : "http",
          cause: undefined,
        });
      }
      return response;
    });
  const json = (operation: string, method: "GET" | "POST", path: string, body?: unknown) =>
    request(operation, method, path, body).pipe(
      Effect.flatMap((response) => response.json),
      Effect.mapError((cause) =>
        isRequestError(cause) || isUnavailableError(cause)
          ? cause
          : new ManagedAgentsRequestError({ operation, category: "protocol", status: 0, cause }),
      ),
    );
  const resource = (operation: string, path: string, body: unknown, prefix: string) =>
    json(operation, "POST", path, body).pipe(
      Effect.flatMap(decodeResource),
      Effect.filterOrFail(
        (value) => new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value.id),
        () =>
          new ManagedAgentsRequestError({
            operation,
            category: "protocol",
            status: 0,
            cause: undefined,
          }),
      ),
      Effect.mapError((cause) =>
        isRequestError(cause) || isUnavailableError(cause)
          ? cause
          : new ManagedAgentsRequestError({ operation, category: "protocol", status: 0, cause }),
      ),
    );

  const run: ManagedAgents["Service"]["run"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (!input.config.enabled)
          return yield* new ManagedAgentsUnavailableError({ reason: "disabled" });
        if (!input.betaOptIn)
          return yield* new ManagedAgentsUnavailableError({ reason: "beta_opt_in_required" });
        if (!credentials.apiKey)
          return yield* new ManagedAgentsUnavailableError({ reason: "api_key_missing" });
        if (!input.prompt.trim() || input.prompt.length > 32_768)
          return yield* new ManagedAgentsInputError({ field: "prompt (1–32768 characters)" });
        if (input.sharedInstructions.length > 40_000)
          return yield* new ManagedAgentsInputError({
            field: "shared instructions (maximum 40000 characters)",
          });
        const cleanupResources: string[] = [];
        const cleanupFailures: string[] = [];
        const workerReports: { eventId: string; threadId: string; text: string }[] = [];
        const acknowledgedCustomUses = new Set<string>();
        let state = emptyManagedWorkflowState();
        const prepareSessionArchive = (path: string) =>
          Effect.gen(function* () {
            let current = record(yield* json("read-cleanup-session", "GET", path));
            if (
              current.status === "terminated" ||
              (current.status === "idle" && state.status === "completed")
            )
              return;
            // A capped session cannot process stop messages. Archive its eligible idle state;
            // if the provider refuses an open run, report that exact resource without raising its cap.
            if (current.status === "idle" && state.status === "budget_reached") return;
            if (state.status === "requires_action") {
              const history = record(
                yield* json("read-blocking-events", "GET", `${path}/events?limit=100`),
              );
              const events = Array.isArray(history.data) ? history.data.map(record) : [];
              const answered = new Set(
                events
                  .filter((event) => event.type === "user.custom_tool_result")
                  .map((event) => idField(event.custom_tool_use_id)),
              );
              for (const event of events)
                if (
                  event.type === "agent.custom_tool_use" &&
                  /^sevt_[A-Za-z0-9]+$/.test(idField(event.id)) &&
                  !answered.has(idField(event.id))
                ) {
                  yield* json("cancel-worker-report", "POST", `${path}/events`, {
                    events: [
                      {
                        type: "user.custom_tool_result",
                        custom_tool_use_id: event.id,
                        is_error: true,
                        content: [
                          {
                            type: "text",
                            text: "Studio is ending this session; this report was canceled.",
                          },
                        ],
                      },
                    ],
                  });
                }
            }
            const openRuns = state.runs.some(
              (run) => !["completed", "stopped", "error"].includes(run.status),
            );
            if (current.status === "running" || openRuns) {
              // Interrupt alone does not stop workflow runs. Ask the lead to stop them explicitly.
              yield* json("interrupt-session", "POST", `${path}/events`, {
                events: [{ type: "user.interrupt" }],
              });
              if (openRuns)
                yield* json("stop-workflows", "POST", `${path}/events`, {
                  events: [
                    {
                      type: "user.message",
                      content: [
                        {
                          type: "text",
                          text: "Stop every open workflow run immediately. Do not start another run. This Studio command has ended; acknowledge briefly.",
                        },
                      ],
                    },
                  ],
                });
            }
            for (let attempt = 0; attempt < 15; attempt++) {
              const history = record(
                yield* json("read-cleanup-events", "GET", `${path}/events?limit=100`),
              );
              let latest = emptyManagedWorkflowState();
              for (const event of Array.isArray(history.data) ? history.data : [])
                latest = reduceManagedWorkflowEvent(latest, event);
              const runOpen = latest.runs.some(
                (run) => !["completed", "stopped", "error"].includes(run.status),
              );
              current = record(yield* json("read-cleanup-session", "GET", path));
              if (current.status === "terminated" || (current.status === "idle" && !runOpen))
                return;
              yield* Effect.sleep("1 second");
            }
            return yield* new ManagedAgentsRequestError({
              operation: "stop-workflows",
              category: "timeout",
              status: 0,
              cause: undefined,
            });
          }).pipe(
            Effect.timeoutOrElse({
              duration: "20 seconds",
              orElse: () =>
                Effect.fail(
                  new ManagedAgentsRequestError({
                    operation: "stop-workflows",
                    category: "timeout",
                    status: 0,
                    cause: undefined,
                  }),
                ),
            }),
          );
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            cleanupResources.toReversed(),
            (path) =>
              (path.startsWith("sessions/") ? prepareSessionArchive(path) : Effect.void).pipe(
                Effect.andThen(json("archive-resource", "POST", `${path}/archive`)),
                Effect.tap(() => Effect.sync(() => input.onResourceArchived?.(path, true))),
                Effect.catch(() =>
                  Effect.sync(() => {
                    cleanupFailures.push(path);
                    input.onResourceArchived?.(path, false);
                  }),
                ),
              ),
            { discard: true },
          ),
        );
        const system = buildManagedAgentsSystem(
          input.sharedInstructions,
          input.config.responseStyle,
        );
        // Text-only beta: no filesystem, web, shell, MCP, vaults or repository mounts.
        const worker = yield* resource(
          "create-worker",
          "agents",
          {
            name: "Studio beta worker",
            model: input.config.model,
            system,
            tools: [
              {
                type: "custom",
                name: "studio_report_result",
                description:
                  "Record the worker's complete answer in the Studio receipt. Call exactly once with the plain-text answer before returning the workflow result. Include required instruction markers. This records text only and does not execute code, access files or contact any other service.",
                input_schema: {
                  type: "object",
                  properties: { text: { type: "string", maxLength: 8192 } },
                  required: ["text"],
                  additionalProperties: false,
                },
              },
            ],
          },
          "agent",
        );
        cleanupResources.push(`agents/${worker.id}`);
        input.onResourceCreated?.(`agents/${worker.id}`);
        const lead = yield* resource(
          "create-lead",
          "agents",
          {
            name: "Studio beta lead",
            model: input.config.model,
            system: `${system}\n\nFor the supplied task, start a small dynamic workflow using the predefined worker, then synthesize its results.`,
            tools: [],
            multiagent: {
              type: "multiagent_20261001",
              subagents: { type: "disabled" },
              workflows: {
                type: "enabled",
                inline_agents: { type: "disabled" },
                predefined_agents: [
                  {
                    type: "agent",
                    id: worker.id,
                    ...(worker.version ? { version: worker.version } : {}),
                  },
                ],
              },
            },
          },
          "agent",
        );
        cleanupResources.push(`agents/${lead.id}`);
        input.onResourceCreated?.(`agents/${lead.id}`);
        const session = yield* resource(
          "create-session",
          "sessions",
          {
            agent: lead.id,
            environment_id: input.config.environmentId,
            budget: {
              type: "limit",
              max_list_cost: { amount: input.config.maxCostCents, currency: "USD" },
            },
            title: "SpecWeave Studio explicit Managed Agents beta run",
          },
          "sesn",
        );
        cleanupResources.push(`sessions/${session.id}`);
        input.onResourceCreated?.(`sessions/${session.id}`);
        const decode = createManagedSseDecoder();
        const response = yield* request(
          "stream-events",
          "GET",
          `sessions/${session.id}/events/stream`,
        );
        yield* json("send-task", "POST", `sessions/${session.id}/events`, {
          events: [{ type: "user.message", content: [{ type: "text", text: input.prompt }] }],
        });
        yield* response.stream.pipe(
          Stream.decodeText,
          Stream.runForEachWhile((chunk) =>
            Effect.gen(function* () {
              const events = yield* Effect.try({
                try: () => decode(chunk),
                catch: (cause) =>
                  new ManagedAgentsRequestError({
                    operation: "decode-stream",
                    category: "protocol",
                    status: 0,
                    cause,
                  }),
              });
              for (const event of events) {
                const value = record(event);
                if (value.type === "agent.custom_tool_use") {
                  const eventId = idField(value.id);
                  const threadId = idField(value.session_thread_id);
                  const text = record(value.input).text;
                  const accepted =
                    value.name === "studio_report_result" &&
                    /^sevt_[A-Za-z0-9]+$/.test(eventId) &&
                    /^sthr_[A-Za-z0-9]+$/.test(threadId) &&
                    typeof text === "string" &&
                    text.length > 0 &&
                    text.length <= 8192;
                  if (accepted && !workerReports.some((report) => report.eventId === eventId))
                    workerReports.push({ eventId, threadId, text });
                  if (/^sevt_[A-Za-z0-9]+$/.test(eventId)) {
                    yield* json(
                      "acknowledge-worker-report",
                      "POST",
                      `sessions/${session.id}/events`,
                      {
                        events: [
                          {
                            type: "user.custom_tool_result",
                            custom_tool_use_id: eventId,
                            is_error: !accepted,
                            content: [
                              {
                                type: "text",
                                text: accepted
                                  ? "Studio recorded this worker answer."
                                  : "Studio rejected the unsupported or invalid report. No action was performed.",
                              },
                            ],
                          },
                        ],
                      },
                    );
                    acknowledgedCustomUses.add(eventId);
                  }
                }
                if (
                  value.type === "session.status_idle" &&
                  record(value.stop_reason).type === "requires_action"
                ) {
                  const ids = record(value.stop_reason).event_ids;
                  if (
                    Array.isArray(ids) &&
                    ids.length > 0 &&
                    ids.every((id) => acknowledgedCustomUses.has(idField(id)))
                  )
                    continue;
                }
                state = reduceManagedWorkflowEvent(state, event);
                input.onProgress?.(state);
                if (state.status !== "running") return false;
              }
              return true;
            }),
          ),
          Effect.timeoutOrElse({
            duration: `${input.config.timeoutSeconds} seconds`,
            orElse: () =>
              Effect.fail(
                new ManagedAgentsRequestError({
                  operation: "workflow-run",
                  category: "timeout",
                  status: 0,
                  cause: undefined,
                }),
              ),
          }),
          Effect.mapError((cause) =>
            isRequestError(cause)
              ? cause
              : new ManagedAgentsRequestError({
                  operation: "stream-events",
                  category: "transport",
                  status: 0,
                  cause,
                }),
          ),
        );
        const evidence: ManagedThreadEvidence[] = [];
        let evidenceComplete = true;
        const threads = yield* json(
          "read-threads",
          "GET",
          `sessions/${session.id}/threads?limit=100`,
        ).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              evidenceComplete = false;
              return {};
            }),
          ),
        );
        const list = record(threads);
        if (
          !Array.isArray(list.data) ||
          list.data.length === 0 ||
          list.has_more === true ||
          list.next_page
        )
          evidenceComplete = false;
        for (const value of (Array.isArray(list.data) ? list.data : []).slice(0, 100)) {
          const thread = record(value);
          const id = idField(thread.id);
          if (!/^sthr_[A-Za-z0-9]+$/.test(id)) {
            evidenceComplete = false;
            continue;
          }
          const events = yield* json(
            "read-thread-events",
            "GET",
            `sessions/${session.id}/threads/${id}/events?limit=100`,
          ).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                evidenceComplete = false;
                return {};
              }),
            ),
          );
          const page = record(events);
          if (
            !Array.isArray(page.data) ||
            page.data.length === 0 ||
            page.has_more === true ||
            page.next_page
          )
            evidenceComplete = false;
          const values = Array.isArray(page.data) ? page.data : [];
          if (
            values.some(
              (event) =>
                typeof record(event).type !== "string" || !idField(record(event).type).trim(),
            )
          )
            evidenceComplete = false;
          let threadState = emptyManagedWorkflowState();
          for (const event of values) threadState = reduceManagedWorkflowEvent(threadState, event);
          evidence.push({
            id,
            workflowRunId:
              typeof thread.workflow_run_id === "string" ? thread.workflow_run_id : null,
            messages: threadState.messages,
            reportMessages: workerReports
              .filter((report) => report.threadId === id)
              .map((report) => report.text),
            agentId:
              typeof record(thread.agent).id === "string"
                ? (record(thread.agent).id as string)
                : null,
            instructionsMatch: record(thread.agent).system === system,
            usage: thread.usage ?? null,
            failed: values.some((event) => ["session.error"].includes(idField(record(event).type))),
          });
        }
        if (state.sawWorkflow) {
          const workers = evidence.filter((thread) => thread.workflowRunId !== null);
          if (
            state.runs.some((run) => !workers.some((thread) => thread.workflowRunId === run.id)) ||
            workers.some(
              (thread) =>
                thread.agentId !== worker.id ||
                !thread.instructionsMatch ||
                thread.reportMessages.length === 0,
            )
          )
            evidenceComplete = false;
        }
        const sessionInfo = yield* json("read-usage", "GET", `sessions/${session.id}`).pipe(
          Effect.catch(() => Effect.succeed({})),
        );
        return {
          sessionId: session.id,
          workerId: worker.id,
          leadId: lead.id,
          state,
          executionComplete: state.status === "completed" && state.sawWorkflow,
          verified: false,
          threadEvidence: evidence,
          evidenceComplete,
          usage: record(sessionInfo).usage ?? null,
          cleanupFailures,
        } satisfies ManagedAgentsReceipt;
      }),
    );
  return ManagedAgents.of({ status, run });
});

export const layer = Layer.effect(ManagedAgents, make);
