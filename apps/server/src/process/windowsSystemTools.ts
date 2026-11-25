// @effect-diagnostics nodeBuiltinImport:off - pure Windows path joining, usable from any platform.
import * as NodePath from "node:path";

/**
 * Windows system tools by absolute path. Windows looks for a bare program
 * name in the current directory before PATH, so `taskkill` spawned with a
 * project folder as its cwd (or a writable folder early on PATH) can run a
 * file someone left there. The system folder comes from `SystemRoot`, which
 * Windows sets for every process.
 */
export const windowsSystemRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  env["SystemRoot"]?.trim() || env["windir"]?.trim() || "C:\\Windows";

export const windowsSystem32Path = (tool: string, env: NodeJS.ProcessEnv = process.env): string =>
  NodePath.win32.join(windowsSystemRoot(env), "System32", tool);

export const windowsSystem32Dir = (env: NodeJS.ProcessEnv = process.env): string =>
  NodePath.win32.join(windowsSystemRoot(env), "System32");

export const windowsPowerShellPath = (env: NodeJS.ProcessEnv = process.env): string =>
  windowsSystem32Path(NodePath.win32.join("WindowsPowerShell", "v1.0", "powershell.exe"), env);
