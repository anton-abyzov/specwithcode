// @effect-diagnostics nodeBuiltinImport:off -- Wraps a synchronous third-party token store, outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { storage } from "@clerk/electron/storage";

type TokenStorage = ReturnType<typeof storage>;

const OWNER_ONLY_FILE_MODE = 0o600;

/** The file `storage({ path })` writes when no name is given. */
export const clerkTokenFilePath = (stateDir: string): string =>
  NodePath.join(stateDir, "clerk-tokens.json");

function restrictToOwner(filePath: string): void {
  try {
    // A symlink would carry the mode to a file this app does not own.
    if (!NodeFS.lstatSync(filePath).isFile()) return;
    NodeFS.chmodSync(filePath, OWNER_ONLY_FILE_MODE);
  } catch {
    // Absent until the first sign-in. The token value stays encrypted either way.
  }
}

/**
 * Keeps the token file readable by its owner only. The underlying store offers
 * no file mode and rewrites the file at 0666 less the umask, so the mode is set
 * again after every call, and an existing file stays in place to keep the user
 * signed in.
 */
export function withOwnerOnlyTokenFile(inner: TokenStorage, filePath: string): TokenStorage {
  restrictToOwner(filePath);
  // Reading can write too: the store re-encrypts or deletes a value it opens.
  const tightenAfter = <A>(result: A | Promise<A>): Promise<A> =>
    Promise.resolve(result).finally(() => restrictToOwner(filePath));
  return {
    getItem: (key) => tightenAfter(inner.getItem(key)),
    setItem: (key, value) => tightenAfter(inner.setItem(key, value)),
    removeItem: (key) => tightenAfter(inner.removeItem(key)),
  };
}
