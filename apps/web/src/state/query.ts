import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { isRpcTransportError } from "@specweave-studio/client-runtime/errors";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-environment-query:empty"),
);

export interface EnvironmentQueryView<A, E = unknown> {
  readonly data: A | null;
  readonly dataUpdatedAt: number;
  readonly error: string | null;
  readonly failure: E | null;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly refresh: () => void;
}

/**
 * The message to show for a failed query, or `null` when the socket under it
 * dropped. A lost socket is the machine's connection state, which the app
 * already shows once; repeating it on every query as a raw socket error (with a
 * Retry that cannot help) is noise. A machine that is not connected or offline
 * keeps its message, as it did before. `failure` still carries the error.
 */
export function formatEnvironmentQueryError(cause: Cause.Cause<unknown>): string | null {
  const error = Cause.squash(cause);
  if (isRpcTransportError(error)) {
    return null;
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A, E> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    dataUpdatedAt:
      result._tag === "Success"
        ? result.timestamp
        : result._tag === "Failure"
          ? (Option.getOrNull(result.previousSuccess)?.timestamp ?? 0)
          : 0,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    failure:
      result._tag === "Failure" ? Option.getOrNull(Cause.findErrorOption(result.cause)) : null,
    isPending: atom !== null && result.waiting,
    isSuccess: result._tag === "Success",
    refresh,
  };
}
