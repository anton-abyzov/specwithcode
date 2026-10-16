// @effect-diagnostics nodeBuiltinImport:off
// The libuv pool is sized once, on its first job, before any Effect runtime
// exists, so this stays on Node built-ins.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

/**
 * Node's libuv pool runs every async fs call, zlib job (each permessage-deflate
 * frame the WebSocket server sends), DNS lookup and crypto hash. It defaults to
 * 4 threads whatever the machine. With several agents streaming, deflate and
 * file reads queue behind each other: on an M4 Max a 1 KB `fs.readFile` waited
 * 38 ms behind 12 deflate jobs with 4 threads, and 0.3 ms with 16. The pool only
 * holds idle threads until work arrives, so a larger one costs little.
 */
export const MIN_SERVER_THREADPOOL_SIZE = 8;
export const MAX_SERVER_THREADPOOL_SIZE = 32;

/**
 * The pool size to use, or `undefined` to leave Node's choice alone because
 * `UV_THREADPOOL_SIZE` is already set.
 */
export const serverThreadPoolSize = (
  configured: string | undefined,
  parallelism: number,
): number | undefined => {
  if (configured !== undefined && configured.trim() !== "") return undefined;
  const cores = Number.isFinite(parallelism) ? Math.floor(parallelism) : 0;
  return Math.min(MAX_SERVER_THREADPOOL_SIZE, Math.max(MIN_SERVER_THREADPOOL_SIZE, cores));
};

/**
 * Sizes the pool for this process. libuv reads `UV_THREADPOOL_SIZE` when the
 * first job is queued, so this queues one (a stat of the Node binary) while the
 * variable is set, then restores the environment so agents, tools and their
 * test runners spawned from the server do not inherit the setting. It must run
 * before anything else uses the pool; later calls have no effect. It does not
 * read the working directory: `process.cwd()` throws when that folder has been
 * deleted, and the CLI still runs from one.
 */
export const ensureServerThreadPoolSize = (
  env: NodeJS.ProcessEnv = process.env,
  parallelism: number = NodeOS.availableParallelism(),
): number | undefined => {
  const size = serverThreadPoolSize(env.UV_THREADPOOL_SIZE, parallelism);
  if (size === undefined) return undefined;
  env.UV_THREADPOOL_SIZE = String(size);
  try {
    NodeFS.stat(process.execPath, () => {});
  } finally {
    delete env.UV_THREADPOOL_SIZE;
  }
  return size;
};
