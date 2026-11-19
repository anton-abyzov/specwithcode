/**
 * One writer of the app at a time per checkout (1390). Sync's fetch, its move
 * and its clone take the checkout by its real path, so two projects that share
 * a folder, or two calls of one, never write to it at once. Kept in this
 * server's memory: Git run in a terminal, or by another process, is not held
 * by it.
 */
const tails = new Map<string, Promise<void>>();

export async function withCheckout<A>(realPath: string, run: () => Promise<A>): Promise<A> {
  const before = tails.get(realPath) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => mine);
  tails.set(realPath, tail);
  await before;
  try {
    return await run();
  } finally {
    release();
    if (tails.get(realPath) === tail) tails.delete(realPath);
  }
}
