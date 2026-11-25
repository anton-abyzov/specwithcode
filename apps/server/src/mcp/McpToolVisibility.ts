/**
 * Which studio-code tools a caller is offered (1483).
 *
 * Effect's `EnabledWhen` sees only the client's protocol profile, not who is
 * calling, so per-caller listing happens here: after sign-in, a `tools/list`
 * answer is rewritten to drop the tools this caller cannot use. Today that is
 * the SpecWeave tools, offered only to a thread whose registered worktree
 * holds `.specweave/`. It fails closed: if the caller's workspace cannot be read,
 * the tools are dropped. Their handlers refuse such a caller as well, so a
 * client that calls an unlisted tool gets a refusal, not a run.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerResponse, type HttpServerRequest } from "effect/http";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import { SPECWEAVE_TOOL_PREFIX } from "./toolkits/specweave/tools.ts";
import { workspaceHasSpecweave } from "./toolkits/specweave/workspace.ts";

const isSpecweaveTool = (name: unknown) =>
  typeof name === "string" && name.startsWith(SPECWEAVE_TOOL_PREFIX);

/** Drops hidden tools from one JSON-RPC message; anything else passes as it is. */
export function dropToolsFromListResult(
  message: unknown,
  hide: (name: unknown) => boolean,
): unknown {
  if (typeof message !== "object" || message === null || !("result" in message)) return message;
  const result = (message as { result: unknown }).result;
  if (typeof result !== "object" || result === null || !("tools" in result)) return message;
  const tools = (result as { tools: unknown }).tools;
  if (!Array.isArray(tools)) return message;
  return {
    ...message,
    result: {
      ...result,
      tools: tools.filter(
        (tool) =>
          !(typeof tool === "object" && tool !== null && hide((tool as { name?: unknown }).name)),
      ),
    },
  };
}

/** Rewrites a JSON or event-stream body; null when it is neither. */
export function rewriteToolListBody(text: string, hide: (name: unknown) => boolean): string | null {
  try {
    return JSON.stringify(dropToolsFromListResult(JSON.parse(text), hide));
  } catch {
    // An event-stream answer: one `data:` line per message.
  }
  if (!text.startsWith("data:")) return null;
  let failed = false;
  const rewritten = text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      try {
        return `data: ${JSON.stringify(dropToolsFromListResult(JSON.parse(line.slice(5)), hide))}`;
      } catch {
        failed = true;
        return line;
      }
    })
    .join("\n");
  return failed ? null : rewritten;
}

const isToolsList = (body: string) => {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { method?: unknown }).method === "tools/list"
    );
  } catch {
    return false;
  }
};

/**
 * Built once with the server's services. A thread caller sees the SpecWeave
 * tools when its registered worktree holds `.specweave/`; an outside client,
 * or a thread working in the project's shared folder, never does.
 */
export const makeToolListFilter = Effect.gen(function* () {
  const threads = yield* Effect.serviceOption(ThreadManagement.ThreadManagementService);

  const offersSpecweave = (invocation: McpInvocationContext.McpInvocationScope) =>
    Effect.gen(function* () {
      if (invocation.thread === undefined || Option.isNone(threads)) return false;
      const shell = yield* threads.value
        .getThreadShell(invocation.thread.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.deletedAt !== null) return false;
      return yield* Effect.promise(() =>
        workspaceHasSpecweave({ worktreePath: shell.worktreePath }),
      );
      // Fails closed on anything, a defect included: the list then leaves them out.
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));

  return (
    request: HttpServerRequest.HttpServerRequest,
    invocation: McpInvocationContext.McpInvocationScope,
    response: HttpServerResponse.HttpServerResponse,
  ) =>
    Effect.gen(function* () {
      if (request.method !== "POST" || response.status !== 200) return response;
      if (response.body._tag !== "Uint8Array") return response;
      const requestBody = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      if (!isToolsList(requestBody)) return response;
      if (yield* offersSpecweave(invocation)) return response;
      const text = new TextDecoder().decode(response.body.body);
      const rewritten = rewriteToolListBody(text, isSpecweaveTool);
      // Unreadable is not something a client could use either; leave it.
      if (rewritten === null) return response;
      return HttpServerResponse.text(rewritten, {
        status: response.status,
        headers: response.headers,
        contentType: response.body.contentType,
      });
    });
});
