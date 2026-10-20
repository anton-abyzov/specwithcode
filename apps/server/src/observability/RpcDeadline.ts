import {
  ProjectWorkspaceError,
  PullRequestOperationError,
  WS_METHODS,
  type WsRpcGroup,
} from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";

type WsRpc = RpcGroup.Rpcs<typeof WsRpcGroup>;
type WsRpcMethod = WsRpc["_tag"];
type WsRpcOf<Tag extends WsRpcMethod> = Rpc.ExtractTag<WsRpc, Tag>;

/** How long a listed RPC may run before the caller is answered without it. */
export const RPC_DEADLINE = Duration.seconds(20);

/**
 * The answer a caller gets once its call passes the deadline. It is typed by the RPC's own
 * success and error schemas, so the client decodes it like any other result.
 */
type DeadlineAnswer<Tag extends WsRpcMethod> = (
  payload: Rpc.Payload<WsRpcOf<Tag>>,
) => Effect.Effect<Rpc.Success<WsRpcOf<Tag>>, Rpc.Error<WsRpcOf<Tag>>>;

const projectReadFailed = (payload: { readonly projectId: ProjectWorkspaceError["projectId"] }) =>
  Effect.fail(
    new ProjectWorkspaceError({ code: "operation_failed", projectId: payload.projectId }),
  );

/**
 * Idempotent reads and reports the client polls or retries anyway. On a stalled host a request
 * that never answers holds the client's request slot and its loading state indefinitely; a typed
 * failure lets the next poll try again. Mutations are not listed: giving up on one would not undo
 * it.
 */
const RPC_DEADLINES: { readonly [Tag in WsRpcMethod]?: DeadlineAnswer<Tag> } = {
  [WS_METHODS.projectsThreadIncrementProgressRead]: projectReadFailed,
  [WS_METHODS.projectsWorkspaceRead]: projectReadFailed,
  [WS_METHODS.pullRequestsLinkedThreads]: () =>
    Effect.fail(
      new PullRequestOperationError({
        operation: "linkedThreads",
        detail: "Reading the linked threads took too long. Try again.",
      }),
    ),
  // A report has nothing to return, and the next one carries the same activity.
  [WS_METHODS.serverReportClientActivity]: () => Effect.void,
};

/** Answers the RPCs in `RPC_DEADLINES` once they pass `RPC_DEADLINE`, and interrupts the handler. */
export class RpcDeadline extends RpcMiddleware.Service<RpcDeadline>()(
  "studio/server/RpcDeadline",
) {}

export const makeRpcDeadline =
  (deadline: Duration.Input = RPC_DEADLINE): RpcMiddleware.RpcMiddleware<never, never, never> =>
  (effect, { rpc, payload }) => {
    const answer = RPC_DEADLINES[rpc._tag as WsRpcMethod] as
      | ((payload: unknown) => Effect.Effect<unknown, unknown>)
      | undefined;
    if (answer === undefined) return effect;
    return effect.pipe(
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () =>
          Effect.logWarning("RPC passed its deadline; answering without it.", {
            method: rpc._tag,
            deadlineMs: Duration.toMillis(deadline),
          }).pipe(
            // The answer is typed against this RPC's own schemas in RPC_DEADLINES; the middleware
            // signature only knows the opaque success marker.
            // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off anyUnknownInErrorContext:off
            Effect.andThen(answer(payload) as Effect.Effect<RpcMiddleware.SuccessValue, never>),
          ),
      }),
    );
  };

export const rpcDeadlineLayer = Layer.succeed(RpcDeadline)(makeRpcDeadline());
