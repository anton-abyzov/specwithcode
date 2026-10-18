// @effect-diagnostics nodeBuiltinImport:off - runs in the Vitest main process, outside any Effect runtime.
import * as NodeFS from "node:fs";
import type { TestProject } from "vite-plus/test/node";

// Vitest keeps a module cache in os.tmpdir()/<21-character id>/{ssr,client}
// and removes the per-project copy on close but never the root one, so every
// run leaves 10-40 MB behind. Remove it when Vitest closes.
export default function setup(project: TestProject): void {
  const directory = (project.vitest as { readonly _tmpDir?: unknown })._tmpDir;
  if (typeof directory !== "string") return;
  project.vitest.onClose(() =>
    NodeFS.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }),
  );
}
