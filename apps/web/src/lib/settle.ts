/**
 * `try`/`finally` for component handlers. The React Compiler cannot compile a
 * `try` with a `finally`, or one without a `catch`, and a single one leaves the
 * whole component unoptimized: each of its renders then renders every child
 * again. Handlers call these instead.
 */
export async function settleAfter<T>(work: () => Promise<T>, settled: () => void): Promise<T> {
  try {
    return await work();
  } finally {
    settled();
  }
}

/** `settleAfter`, with a failure reported instead of rethrown. */
export async function settleCaught<T>(
  work: () => Promise<T>,
  failed: (error: unknown) => void | Promise<void>,
  settled: () => void,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    await failed(error);
    return undefined;
  } finally {
    settled();
  }
}
