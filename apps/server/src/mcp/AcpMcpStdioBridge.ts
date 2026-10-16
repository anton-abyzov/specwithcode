// The bridge relays opaque JSON-RPC lines verbatim; schema-decoding foreign
// payloads here would reject traffic it must pass through untouched.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodeReadline from "node:readline";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

/**
 * Stdio-to-HTTP bridge for Studio's MCP endpoint.
 *
 * ACP agents must support stdio MCP servers, while optional http/sse support
 * is unevenly implemented. `specweave-studio acp-mcp-bridge` runs as the stdio MCP server an
 * ACP agent spawns and forwards each JSON-RPC line to Studio's authenticated
 * streamable-HTTP endpoint: single JSON responses and SSE streams are written
 * back as newline-delimited JSON-RPC, notification acknowledgements (202/204)
 * produce no output, and the `mcp-session-id` / negotiated protocol version
 * are replayed on subsequent requests.
 *
 * Credentials are not frozen at spawn time. After a 401 or an unreachable
 * endpoint the bridge re-reads the thread's owner-only credential file and, if
 * the endpoint or token moved, retries the request once. A 404 for a session
 * the server no longer knows (it restarted) re-runs the agent's initialize
 * handshake once, invisibly to the agent, and retries. Each request gets at
 * most one of each recovery, so a credential that is really gone fails fast.
 *
 * This entry sits on the ACP first-message critical path (bin.ts fast-paths
 * it before the CLI graph), so it imports only effect core modules; keep the
 * import list lean when changing it.
 */

export class AcpMcpBridgeError extends Error {
  readonly _tag = "AcpMcpBridgeError";
}

const bridgeError = (cause: unknown): AcpMcpBridgeError =>
  cause instanceof AcpMcpBridgeError
    ? cause
    : new AcpMcpBridgeError(cause instanceof Error ? cause.message : String(cause), { cause });

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AcpMcpCredentials {
  readonly endpoint: string;
  readonly authorization: string;
}

/** Reads the current credentials, or undefined when none can be read. */
export type AcpMcpCredentialSource = () => Promise<AcpMcpCredentials | undefined>;

/**
 * Reads `{ endpoint, authorization }` from the owner-only file the server
 * rewrites whenever it issues the thread's credential. Never throws: a
 * missing or malformed file reads as undefined.
 */
export async function readAcpMcpCredentialFile(
  path: string,
): Promise<AcpMcpCredentials | undefined> {
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { endpoint, authorization } = parsed as Record<string, unknown>;
    return typeof endpoint === "string" &&
      endpoint.length > 0 &&
      typeof authorization === "string" &&
      authorization.length > 0
      ? { endpoint, authorization }
      : undefined;
  } catch {
    return undefined;
  }
}

const credentialSourceOf = (options: {
  readonly credentialFile?: string;
  readonly readCredentials?: AcpMcpCredentialSource;
}): AcpMcpCredentialSource | undefined =>
  options.readCredentials ??
  (options.credentialFile === undefined
    ? undefined
    : () => readAcpMcpCredentialFile(options.credentialFile!));

const sameCredentials = (left: AcpMcpCredentials, right: AcpMcpCredentials) =>
  left.endpoint === right.endpoint && left.authorization === right.authorization;

/**
 * Reads fresh credentials and reports whether they differ from the ones the
 * failed request used. Unchanged credentials mean a retry would fail the same
 * way, so the caller gives up instead.
 */
const refreshedCredentials = (
  source: AcpMcpCredentialSource | undefined,
  used: AcpMcpCredentials,
): Effect.Effect<AcpMcpCredentials | undefined> =>
  source === undefined
    ? Effect.succeed(undefined)
    : Effect.promise(() => source().catch(() => undefined)).pipe(
        Effect.map((fresh) =>
          fresh === undefined || sameCredentials(fresh, used) ? undefined : fresh,
        ),
      );

/**
 * True when the connection was refused, so the request never reached a
 * server. Any other transport failure may hit after the server already ran
 * the call, and replaying it could repeat a side effect.
 */
export const isConnectionRefused = (cause: unknown): boolean => {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    const record = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (record.code === "ECONNREFUSED") return true;
    if (Array.isArray(record.errors) && record.errors.some(visit)) return true;
    return visit(record.cause);
  };
  return visit(cause);
};

const httpStatusError = (status: number): AcpMcpBridgeError =>
  new AcpMcpBridgeError(
    status === 401
      ? "SpecWithCode MCP endpoint responded with HTTP 401: this agent's SpecWithCode credential is no longer valid. Send another message in the thread to reconnect."
      : `SpecWithCode MCP endpoint responded with HTTP ${status}.`,
  );

export interface AcpMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  /** Owner-only file holding the thread's current credentials; re-read after a 401. */
  readonly credentialFile?: string;
  /** Overrides `credentialFile` as the source of fresh credentials. */
  readonly readCredentials?: AcpMcpCredentialSource;
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

async function* sseDataLines(response: Response): AsyncGenerator<string> {
  if (response.body === null) return;
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });
    let separatorIndex = buffered.search(/\n\n|\r\n\r\n/u);
    while (separatorIndex !== -1) {
      const rawEvent = buffered.slice(0, separatorIndex);
      buffered = buffered.slice(separatorIndex).replace(/^(?:\r?\n){2}/u, "");
      const data = rawEvent
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data.length > 0) yield data;
      separatorIndex = buffered.search(/\n\n|\r\n\r\n/u);
    }
  }
}

const discardResponseBody = (response: Response): Effect.Effect<void> =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

/**
 * Every JSON-RPC payload carried by a response, in arrival order: nothing for
 * notification acknowledgements, each SSE `data:` event as it streams in, or
 * the single JSON body.
 */
export function responsePayloads(response: Response): Stream.Stream<unknown, AcpMcpBridgeError> {
  if (response.status === 202 || response.status === 204) {
    return Stream.unwrap(discardResponseBody(response).pipe(Effect.as(Stream.empty)));
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return Stream.fromAsyncIterable(sseDataLines(response), bridgeError).pipe(
      Stream.mapEffect((data) => Effect.try({ try: () => JSON.parse(data), catch: bridgeError })),
    );
  }
  return Stream.unwrap(
    Effect.tryPromise({ try: () => response.text(), catch: bridgeError }).pipe(
      Effect.flatMap((text) =>
        text.trim().length === 0
          ? Effect.succeed(Stream.empty)
          : Effect.try({ try: () => JSON.parse(text) as unknown, catch: bridgeError }).pipe(
              Effect.map((payload) => Stream.fromIterable([payload])),
            ),
      ),
    ),
  );
}

export interface AcpMcpToolCallOptions {
  readonly endpoint: string;
  readonly authorization: string;
  /** Owner-only file holding the thread's current credentials; re-read after a 401. */
  readonly credentialFile?: string;
  readonly readCredentials?: AcpMcpCredentialSource;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Call one MCP tool through a fresh authenticated HTTP session.
 *
 * This is the terminal fallback for ACP agents that accept `mcpServers` in
 * `session/new` but fail to expose those tools to their model. Compliant ACP
 * agents continue to use the stdio bridge above.
 */
export function callAcpMcpTool(
  options: AcpMcpToolCallOptions,
): Effect.Effect<unknown, AcpMcpBridgeError> {
  const credentialSource = credentialSourceOf(options);
  const initial: AcpMcpCredentials = {
    endpoint: options.endpoint,
    authorization: options.authorization,
  };
  // A rejected or unreachable credential restarts the whole handshake once
  // with fresh credentials; the new attempt has no further retry.
  return callAcpMcpToolWith(options, initial).pipe(
    Effect.catch((error) =>
      error.recoverable
        ? refreshedCredentials(credentialSource, initial).pipe(
            Effect.flatMap((fresh) =>
              fresh === undefined
                ? Effect.fail(error.error)
                : callAcpMcpToolWith(options, fresh).pipe(Effect.mapError(({ error }) => error)),
            ),
          )
        : Effect.fail(error.error),
    ),
  );
}

interface ToolCallFailure {
  readonly error: AcpMcpBridgeError;
  /** True for a 401 or a refused connection: fresh credentials may fix it. */
  readonly recoverable: boolean;
}

function callAcpMcpToolWith(
  options: AcpMcpToolCallOptions,
  credentials: AcpMcpCredentials,
): Effect.Effect<unknown, ToolCallFailure> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const fatal = (error: AcpMcpBridgeError): ToolCallFailure => ({ error, recoverable: false });
  return Effect.gen(function* () {
    // The bridge is single-fibered at creation time; concurrent sends only
    // read these after the sequential handshake, so plain locals suffice.
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;

    const send = (message: unknown): Effect.Effect<ReadonlyArray<unknown>, ToolCallFailure> =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImplementation(credentials.endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: credentials.authorization,
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: JSON.stringify(message),
            }),
          catch: (cause): ToolCallFailure => ({
            error: bridgeError(cause),
            recoverable: isConnectionRefused(cause),
          }),
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          yield* discardResponseBody(response);
          return yield* Effect.fail({
            error: httpStatusError(response.status),
            recoverable: response.status === 401,
          });
        }
        const payloads = yield* Stream.runCollect(responsePayloads(response)).pipe(
          Effect.mapError(fatal),
        );
        for (const payload of payloads) {
          protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
        }
        return payloads;
      });

    const initializeId = "studio-acp-cli-initialize";
    const initialized = yield* send({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "studio-code-acp-cli", version: "0.0.0" },
      },
    });
    const initializeResponse = initialized.find((entry) => asEnvelope(entry)?.id === initializeId);
    if (initializeResponse === undefined || asEnvelope(initializeResponse)?.error !== undefined) {
      return yield* Effect.fail(
        fatal(new AcpMcpBridgeError("SpecWithCode MCP endpoint rejected initialization.")),
      );
    }
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const callId = "studio-acp-cli-tool-call";
    const responses = yield* send({
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: { name: options.tool, arguments: options.arguments },
    });
    const response = responses.find((entry) => asEnvelope(entry)?.id === callId);
    const envelope = asEnvelope(response);
    if (envelope === null || envelope.error !== undefined) {
      return yield* Effect.fail(
        fatal(
          new AcpMcpBridgeError(
            `SpecWithCode MCP tool call failed${envelope?.error === undefined ? "." : `: ${JSON.stringify(envelope.error)}`}`,
          ),
        ),
      );
    }
    return envelope.result;
  });
}

const REINITIALIZE_REQUEST_ID = "studio-acp-mcp-bridge-reinitialize";

export function runAcpMcpStdioBridge(options: AcpMcpStdioBridgeOptions): Effect.Effect<void> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const credentialSource = credentialSourceOf(options);
  return Effect.gen(function* () {
    // Dispatch happens synchronously on the single stream fiber, so plain
    // locals carry the shared session state; forwards mutate them in
    // completion order exactly like the wire does.
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;
    let credentials: AcpMcpCredentials = {
      endpoint: options.endpoint,
      authorization: options.authorization,
    };
    // The agent's own initialize params, replayed if the server loses the session.
    let initializeParams: unknown = undefined;
    let reinitializing:
      | { readonly staleSessionId: string; readonly done: Deferred.Deferred<boolean> }
      | undefined;
    const running = new Set<Fiber.Fiber<void>>();

    const post = (
      body: string,
      used: AcpMcpCredentials,
      session: { readonly sessionId: string | null; readonly protocolVersion: string | null },
    ) =>
      Effect.tryPromise({
        try: () =>
          fetchImplementation(used.endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              authorization: used.authorization,
              ...(session.sessionId === null ? {} : { "mcp-session-id": session.sessionId }),
              ...(session.protocolVersion === null
                ? {}
                : { "mcp-protocol-version": session.protocolVersion }),
            },
            body,
          }),
        catch: (cause) => ({ error: bridgeError(cause), refused: isConnectionRefused(cause) }),
      });

    /** Adopts fresh credentials when they differ from the ones a request used. */
    const refresh = (used: AcpMcpCredentials): Effect.Effect<boolean> =>
      refreshedCredentials(credentialSource, used).pipe(
        Effect.map((fresh) => {
          if (fresh === undefined) {
            // Another request may already have adopted newer credentials.
            return !sameCredentials(credentials, used);
          }
          credentials = fresh;
          return true;
        }),
      );

    /**
     * Opens a replacement MCP session with the agent's original initialize
     * params. Concurrent requests that hit the same lost session share one
     * attempt; a request whose session was already replaced just retries.
     */
    const reinitialize = (staleSessionId: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (sessionId !== staleSessionId) return true;
        if (reinitializing?.staleSessionId === staleSessionId) {
          return yield* Deferred.await(reinitializing.done);
        }
        if (initializeParams === undefined) return false;
        const done = yield* Deferred.make<boolean>();
        reinitializing = { staleSessionId, done };
        const attempt = Effect.gen(function* () {
          const used = credentials;
          const response = yield* post(
            JSON.stringify({
              jsonrpc: "2.0",
              id: REINITIALIZE_REQUEST_ID,
              method: "initialize",
              params: initializeParams,
            }),
            used,
            { sessionId: null, protocolVersion: null },
          );
          const freshSessionId = response.headers.get("mcp-session-id");
          if (!response.ok || freshSessionId === null) {
            yield* discardResponseBody(response);
            return false;
          }
          const payloads = yield* Stream.runCollect(responsePayloads(response));
          const initialized = payloads.find(
            (entry) => asEnvelope(entry)?.id === REINITIALIZE_REQUEST_ID,
          );
          if (initialized === undefined || asEnvelope(initialized)?.error !== undefined) {
            return false;
          }
          const freshProtocolVersion = protocolVersionOf(initialized) ?? protocolVersion;
          const acknowledged = yield* post(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            used,
            { sessionId: freshSessionId, protocolVersion: freshProtocolVersion },
          );
          yield* discardResponseBody(acknowledged);
          if (!acknowledged.ok) return false;
          sessionId = freshSessionId;
          protocolVersion = freshProtocolVersion;
          return true;
        }).pipe(
          Effect.catchCause(() => Effect.succeed(false)),
          Effect.tap((succeeded) => Deferred.succeed(done, succeeded)),
          // Waiters must never hang, even if this attempt is interrupted.
          Effect.ensuring(
            Deferred.succeed(done, false).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (reinitializing?.done === done) reinitializing = undefined;
                }),
              ),
            ),
          ),
        );
        return yield* attempt;
      });

    const writeMessage = (message: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        options.output.write(`${JSON.stringify(message)}\n`);
      });

    const handleServerPayload = (payload: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const entry of Array.isArray(payload) ? payload : [payload]) {
          protocolVersion = protocolVersionOf(entry) ?? protocolVersion;
          yield* writeMessage(entry);
        }
      });

    const respondWithError = (
      requestId: unknown,
      message: string,
      code = -32603,
    ): Effect.Effect<void> =>
      writeMessage({
        jsonrpc: "2.0",
        id: requestId ?? null,
        error: { code, message },
      });

    const forward = (line: string, envelope: JsonRpcEnvelope): Effect.Effect<void> =>
      Effect.gen(function* () {
        const isInitialize = envelope.method === "initialize";
        if (isInitialize) initializeParams = envelope.params ?? {};
        // Only requests and notifications are replayed into a new session; a
        // response to a server request from the lost session has no target.
        const canReinitialize = !isInitialize && typeof envelope.method === "string";
        let refreshed = false;
        let reinitialized = false;
        let response: Response;
        while (true) {
          const used = credentials;
          const usedSessionId = sessionId;
          const sent = yield* post(line, used, { sessionId, protocolVersion }).pipe(Effect.result);
          if (sent._tag === "Failure") {
            if (sent.failure.refused && !refreshed && (yield* refresh(used))) {
              refreshed = true;
              continue;
            }
            return yield* Effect.fail(sent.failure.error);
          }
          response = sent.success;
          if (response.status === 401 && !refreshed) {
            if (yield* refresh(used)) {
              refreshed = true;
              yield* discardResponseBody(response);
              continue;
            }
          }
          if (
            response.status === 404 &&
            usedSessionId !== null &&
            canReinitialize &&
            !reinitialized
          ) {
            reinitialized = true;
            yield* discardResponseBody(response);
            if (yield* reinitialize(usedSessionId)) continue;
            if (envelope.id !== undefined) {
              yield* respondWithError(envelope.id, httpStatusError(404).message);
            }
            return;
          }
          break;
        }
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          if (envelope.id !== undefined) {
            yield* respondWithError(envelope.id, httpStatusError(response.status).message);
          }
          return yield* discardResponseBody(response);
        }
        yield* Stream.runForEach(responsePayloads(response), handleServerPayload);
      }).pipe(
        Effect.catchCause((cause) => {
          if (envelope.id === undefined) return Effect.void;
          const error = Cause.squash(cause);
          return respondWithError(
            envelope.id,
            `SpecWithCode MCP bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      );

    // Only session establishment is ordered; client responses to
    // server-initiated SSE requests must bypass the barrier or they would
    // deadlock the still-open HTTP exchange, and normal MCP calls stay
    // concurrent after initialization.
    let sessionBarrier: Effect.Effect<void> = Effect.void;
    let sessionBarrierPending = false;

    const launch = (task: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(task);
        running.add(fiber);
        yield* Effect.forkChild(
          Fiber.await(fiber).pipe(
            Effect.andThen(
              Effect.sync(() => {
                running.delete(fiber);
              }),
            ),
          ),
        );
      });

    const dispatch = (line: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (line.trim().length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return yield* respondWithError(null, "Parse error", -32700);
        }
        const envelope = asEnvelope(parsed);
        if (envelope === null) return;
        const isResponse =
          envelope.id !== undefined && ("result" in envelope || "error" in envelope);
        const isSessionHandshake =
          envelope.method === "initialize" || envelope.method === "notifications/initialized";
        if (isResponse) {
          return yield* launch(forward(line, envelope));
        }
        if (isSessionHandshake) {
          const prior = sessionBarrier;
          const fiber = yield* Effect.forkChild(
            prior.pipe(Effect.andThen(forward(line, envelope))),
          );
          running.add(fiber);
          const barrier = Fiber.await(fiber).pipe(Effect.asVoid);
          sessionBarrier = barrier;
          sessionBarrierPending = true;
          yield* Effect.forkChild(
            Fiber.await(fiber).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  running.delete(fiber);
                  if (sessionBarrier === barrier) sessionBarrierPending = false;
                }),
              ),
            ),
          );
          return;
        }
        const task = sessionBarrierPending
          ? sessionBarrier.pipe(Effect.andThen(forward(line, envelope)))
          : forward(line, envelope);
        return yield* launch(task);
      });

    const reader = NodeReadline.createInterface({ input: options.input });
    yield* Stream.runForEach(Stream.fromAsyncIterable(reader, bridgeError), dispatch).pipe(
      Effect.catchCause(() => Effect.void),
    );
    yield* Fiber.awaitAll(running);
  });
}

/**
 * Argv runner for `specweave-studio acp-mcp-bridge` and `specweave-studio acp-mcp-call`, shared by the
 * fast-path dispatch in bin.ts and the full CLI's command handlers. Kept free
 * of heavy imports: these commands run on the ACP first-message critical path.
 */
export async function runAcpMcpCliFastPath(
  command: "acp-mcp-bridge" | "acp-mcp-call",
  args: ReadonlyArray<string>,
): Promise<void> {
  // The credential file is rewritten on every issue, so it beats the values
  // captured in this process's environment when the agent was spawned.
  const credentialFile = process.env.STUDIO_ACP_MCP_CREDENTIAL_FILE || undefined;
  const fromFile =
    credentialFile === undefined ? undefined : await readAcpMcpCredentialFile(credentialFile);
  const endpoint = fromFile?.endpoint ?? process.env.STUDIO_ACP_MCP_ENDPOINT;
  const authorization = fromFile?.authorization ?? process.env.STUDIO_ACP_MCP_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined) {
    process.stderr.write(
      `${command} requires STUDIO_ACP_MCP_ENDPOINT and STUDIO_ACP_MCP_AUTHORIZATION.\n`,
    );
    process.exitCode = 2;
    return;
  }
  const credentialOptions = credentialFile === undefined ? {} : { credentialFile };
  if (command === "acp-mcp-bridge") {
    await Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint,
        authorization,
        ...credentialOptions,
        input: process.stdin,
        output: process.stdout,
      }),
    );
    return;
  }
  const [tool, argumentsJson] = args;
  if (tool === undefined || argumentsJson === undefined) {
    process.stderr.write("acp-mcp-call requires <tool> and <arguments-json>.\n");
    process.exitCode = 2;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    process.stderr.write("acp-mcp-call arguments must be valid JSON.\n");
    process.exitCode = 2;
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("acp-mcp-call arguments must be a JSON object.\n");
    process.exitCode = 2;
    return;
  }
  const result = await Effect.runPromise(
    callAcpMcpTool({
      endpoint,
      authorization,
      ...credentialOptions,
      tool,
      arguments: parsed as Record<string, unknown>,
    }),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
