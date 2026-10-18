import { parseJson } from "../json.ts";
import * as Data from "effect/Data";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { checkIdentity, FleetError } from "../studioFleet.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";

/**
 * The only tools this server calls on another machine's `/mcp`. Project
 * create/delete/clone, worktree and pull request tools are never reachable
 * through a worker grant from here, whatever the grant itself would allow.
 */
export const REMOTE_TOOL_ALLOWLIST = [
  "orchestrator_capabilities",
  "studio_project_list",
  "studio_project_read",
  "studio_thread_launch",
  "studio_thread_list",
  "studio_thread_read",
  "studio_thread_wait",
  "studio_thread_send",
  "studio_thread_interrupt",
  // chrome_* calls for a thread here, run in the Chrome paired on that machine.
  "chrome_peer",
] as const;
export type RemoteTool = (typeof REMOTE_TOOL_ALLOWLIST)[number];

// A Chrome screenshot comes back as base64, twice (structured and text); chrome_peer
// refuses images past 8 MiB of base64 so its answers fit.
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const IDENTITY_TTL = Duration.minutes(5);
const DEFAULT_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

export const RemoteMcpErrorReason = Schema.Literals([
  "unknown_machine",
  "not_authorized",
  "unreachable",
  "identity_mismatch",
  "unsupported",
  "refused",
  "tool_failure",
  "invalid_response",
]);
export type RemoteMcpErrorReason = typeof RemoteMcpErrorReason.Type;

/**
 * A remote call that did not produce a result. `tool_failure` carries the
 * other machine's own failure code and message, which are its server's
 * words, never the remote agent's.
 */
export class RemoteMcpError extends Schema.TaggedError<RemoteMcpError>()("RemoteMcpError", {
  reason: RemoteMcpErrorReason,
  grant: Schema.optional(Schema.Literals(["not_allowed", "revoked", "expired"])),
  remoteCode: Schema.optional(Schema.String),
  remoteMessage: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "tool_failure"
      ? (this.remoteMessage ?? "The other machine refused the request.")
      : {
          unknown_machine: "This machine is not configured.",
          not_authorized: "This server may not start or read workers on that machine.",
          unreachable: "The machine is unavailable.",
          identity_mismatch: "That address now belongs to a different machine.",
          unsupported: "That machine's SpecWithCode does not support this.",
          refused: "That tool is not available through a worker grant.",
          tool_failure: "The other machine refused the request.",
          invalid_response: "The other machine sent an unreadable answer.",
        }[this.reason];
  }
}

interface Session {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
  readonly accessToken: string;
  identityCheckedAt: number;
  rejected: boolean;
}

export class RemoteStudioMcpClient extends Context.Service<
  RemoteStudioMcpClient,
  {
    /** Calls an allowlisted tool and returns its structured result. */
    readonly call: (input: {
      readonly machineId: string;
      readonly tool: RemoteTool;
      readonly arguments: Record<string, unknown>;
      readonly timeoutMs?: number | undefined;
    }) => Effect.Effect<unknown, RemoteMcpError>;
    /** Drops a machine's open session, as after its grant changed. */
    readonly forget: (machineId: string) => Effect.Effect<void>;
  }
>()("specweave-studio/fleet/RemoteStudioMcpClient") {}

/** Counts response bytes and fails the stream past the cap. */
const capped = (response: Response): Response => {
  if (response.body === null) return response;
  let seen = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_RESPONSE_BYTES) {
        controller.error(new Error("Remote MCP response exceeded its size limit."));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(limit), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An `OrchestratorMcpFailure` as Effect's MCP server encodes a declared failure. */
const parseFailure = (text: string | undefined) => {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = parseJson(text);
    return isRecord(parsed) && typeof parsed.code === "string" && typeof parsed.message === "string"
      ? { code: parsed.code.slice(0, 64), message: parsed.message.slice(0, 2_000) }
      : undefined;
  } catch {
    return { code: "orchestration_error", message: text.slice(0, 2_000) };
  }
};

const make = Effect.gen(function* () {
  const targets = yield* FleetTargets.FleetTargets;
  const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
  const sessions = yield* Ref.make<ReadonlyMap<string, Session>>(new Map());

  const close = (session: Session) =>
    Effect.promise(async () => {
      await session.client.close().catch(() => undefined);
      await session.transport.close().catch(() => undefined);
    });

  const forget: RemoteStudioMcpClient["Service"]["forget"] = (machineId) =>
    Ref.modify(sessions, (current) => {
      const next = new Map(current);
      const existing = next.get(machineId);
      next.delete(machineId);
      return [existing, next] as const;
    }).pipe(Effect.flatMap((existing) => (existing ? close(existing) : Effect.void)));

  /** Closes `session` only while it is still the machine's open one. */
  const retire = (machineId: string, session: Session) =>
    Ref.modify(sessions, (current) => {
      if (current.get(machineId) !== session) return [false, current] as const;
      const next = new Map(current);
      next.delete(machineId);
      return [true, next] as const;
    }).pipe(Effect.flatMap((removed) => (removed ? close(session) : Effect.void)));

  const grantError = (error: FleetWorkerGrants.FleetWorkerGrantError) =>
    error.reason === "unknown_machine"
      ? new RemoteMcpError({ reason: "unknown_machine" })
      : error.reason === "not_allowed" || error.reason === "revoked" || error.reason === "expired"
        ? new RemoteMcpError({ reason: "not_authorized", grant: error.reason })
        : new RemoteMcpError({ reason: "unreachable", cause: error });

  const verifyIdentity = (credential: FleetWorkerGrants.WorkerCredential) =>
    Effect.tryPromise({
      try: () => checkIdentity(targets.fetch, credential.target),
      catch: (error) =>
        new RemoteMcpError({
          reason:
            error instanceof FleetError && error.kind === "identity-mismatch"
              ? "identity_mismatch"
              : "unreachable",
          cause: error,
        }),
    });

  const open = (credential: FleetWorkerGrants.WorkerCredential) =>
    Effect.gen(function* () {
      yield* verifyIdentity(credential);
      const now = yield* Clock.currentTimeMillis;
      const holder: { session?: Session } = {};
      const origin = credential.target.url;
      const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        // The grant only ever goes to the configured origin's /mcp.
        if (url.origin !== origin || url.pathname !== "/mcp")
          throw new Error("Refused a request outside the machine's MCP endpoint.");
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${credential.accessToken}`);
        headers.delete("origin");
        const response = await targets.fetch(url, { ...init, headers, redirect: "error" });
        if (response.status === 401 && holder.session) holder.session.rejected = true;
        return capped(response);
      };
      const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        fetch: fetcher,
      });
      const client = new Client(
        { name: "specweave-studio-workers", version: packageJson.version },
        { capabilities: {} },
      );
      const session: Session = {
        client,
        transport,
        accessToken: credential.accessToken,
        identityCheckedAt: now,
        rejected: false,
      };
      holder.session = session;
      yield* Effect.tryPromise({
        // The SDK declares `sessionId?: string` without `| undefined`, which this
        // repo's exactOptionalPropertyTypes rejects; the transport is the SDK's own.
        try: () => client.connect(transport as Transport, { timeout: CONNECT_TIMEOUT_MS }),
        catch: (cause) =>
          new RemoteMcpError({
            reason: session.rejected ? "not_authorized" : "unreachable",
            ...(session.rejected ? { grant: "revoked" as const } : {}),
            cause,
          }),
      }).pipe(
        Effect.tapError(() => close(session)),
        Effect.tapError((error) =>
          error.reason === "not_authorized"
            ? grants.reportRejected(credential.target.id, credential.accessToken)
            : Effect.void,
        ),
      );
      return session;
    });

  /** The machine's open session for this grant, opening or refreshing it as needed. */
  const sessionFor = (machineId: string) =>
    Effect.gen(function* () {
      const credential = yield* grants.credential(machineId).pipe(Effect.mapError(grantError));
      const existing = (yield* Ref.get(sessions)).get(machineId);
      const now = yield* Clock.currentTimeMillis;
      if (existing && existing.accessToken === credential.accessToken && !existing.rejected) {
        if (now - existing.identityCheckedAt > Duration.toMillis(IDENTITY_TTL)) {
          yield* verifyIdentity(credential).pipe(Effect.tapError(() => forget(machineId)));
          existing.identityCheckedAt = now;
        }
        return { session: existing, credential };
      }
      if (existing) yield* forget(machineId);
      const session = yield* open(credential);
      yield* Ref.update(sessions, (current) => new Map(current).set(machineId, session));
      return { session, credential };
    });

  class NativeCallFailure extends Data.TaggedError("NativeCallFailure")<{ cause: unknown }> {}

  const call: RemoteStudioMcpClient["Service"]["call"] = (input) =>
    Effect.gen(function* () {
      if (!(REMOTE_TOOL_ALLOWLIST as ReadonlyArray<string>).includes(input.tool))
        return yield* new RemoteMcpError({ reason: "refused" });
      const { session, credential } = yield* sessionFor(input.machineId);
      const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = yield* Effect.tryPromise({
        try: () =>
          session.client.callTool({ name: input.tool, arguments: input.arguments }, undefined, {
            timeout,
            maxTotalTimeout: timeout,
          }),
        catch: (cause) => new NativeCallFailure({ cause }),
      }).pipe(
        Effect.catch((failure) =>
          Effect.gen(function* () {
            const cause = failure.cause;
            // A call that timed out or that the machine answered with an error
            // leaves the session usable for the other calls sharing it. Only a
            // broken transport or a rejected grant closes it.
            const sessionStillGood =
              !session.rejected &&
              cause instanceof McpError &&
              cause.code !== ErrorCode.ConnectionClosed;
            if (!sessionStillGood) yield* retire(input.machineId, session);
            if (session.rejected) {
              yield* grants.reportRejected(input.machineId, credential.accessToken);
              return yield* new RemoteMcpError({
                reason: "not_authorized",
                grant: "revoked",
                cause,
              });
            }
            const message = cause instanceof Error ? cause.message : "";
            return yield* new RemoteMcpError({
              reason: /Tool .* not found|Unknown tool|-32601/u.test(message)
                ? "unsupported"
                : "unreachable",
              cause,
            });
          }),
        ),
      );
      yield* grants.reportAccepted(input.machineId);
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.find(
        (part): part is { type: "text"; text: string } =>
          isRecord(part) && part.type === "text" && typeof part.text === "string",
      )?.text;
      if (result.isError === true) {
        const failure = parseFailure(text);
        return yield* new RemoteMcpError({
          reason: "tool_failure",
          remoteCode: failure?.code ?? "orchestration_error",
          remoteMessage: failure?.message ?? "The other machine refused the request.",
        });
      }
      if (result.structuredContent !== undefined) return result.structuredContent;
      if (text === undefined) return yield* new RemoteMcpError({ reason: "invalid_response" });
      return yield* Effect.try({
        try: () => parseJson(text) as unknown,
        catch: (cause) => new RemoteMcpError({ reason: "invalid_response", cause }),
      });
    });

  yield* Effect.addFinalizer(() =>
    Ref.get(sessions).pipe(
      Effect.flatMap((current) => Effect.forEach(current.values(), close, { discard: true })),
    ),
  );

  return RemoteStudioMcpClient.of({ call, forget });
});

export const layer = Layer.effect(RemoteStudioMcpClient, make);
