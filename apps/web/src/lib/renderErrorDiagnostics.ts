import { useEffect, useState } from "react";

/**
 * Extra detail for render-error reports. React's "Maximum update depth
 * exceeded" (#185) throws from inside the reconciler, so Chrome's default
 * 10-frame stack ends before the app code that kept setting state, and the
 * error itself carries no component names.
 */

const MIN_STACK_TRACE_LIMIT = 50;

const componentStacks = new WeakMap<object, string>();

export function raiseErrorStackTraceLimit(
  target: { stackTraceLimit?: number } = Error as { stackTraceLimit?: number },
): void {
  const current = target.stackTraceLimit;
  if (typeof current !== "number" || current < MIN_STACK_TRACE_LIMIT) {
    target.stackTraceLimit = MIN_STACK_TRACE_LIMIT;
  }
}

/** Remembers the component stack React reports for an error an error boundary caught. */
export function recordRenderErrorComponentStack(
  error: unknown,
  errorInfo: { readonly componentStack?: string | null | undefined },
): void {
  const componentStack = errorInfo.componentStack?.trim();
  if (componentStack && typeof error === "object" && error !== null) {
    componentStacks.set(error, componentStack);
  }
}

/** Report lines naming the components that were rendering when `error` was caught. */
export function renderErrorComponentStackLines(error: unknown): string[] {
  if (typeof error !== "object" || error === null) {
    return [];
  }
  const componentStack = componentStacks.get(error);
  return componentStack ? ["", "Component stack:", componentStack] : [];
}

/**
 * The component stack lines for an error a boundary is showing. React reports
 * the stack (onCaughtError) only when it commits the boundary's fallback, after
 * the fallback has rendered, so this reads it once the fallback is mounted.
 */
export function useRenderErrorComponentStackLines(error: unknown): string[] {
  const [lines, setLines] = useState<{ error: unknown; lines: string[] }>({ error, lines: [] });
  useEffect(() => {
    setLines({ error, lines: renderErrorComponentStackLines(error) });
  }, [error]);
  return lines.error === error ? lines.lines : [];
}
