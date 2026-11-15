// @effect-diagnostics nodeBuiltinImport:off - electron-builder calls this hook by path with plain promises.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

interface AfterPackContext {
  readonly appOutDir: string;
}

// Electron's Linux zips can ship group- and world-writable files (some releases
// have 0777 binaries), and electron-builder copies zip modes verbatim into the
// .deb and the AppImage, so any local user could overwrite the installed app.
export default async function afterPack(context: AfterPackContext): Promise<void> {
  await removeSharedWriteAccess(context.appOutDir);
}

// Walks by hand and never follows a symlink: recursive readdir follows directory
// links out of the app folder.
export async function removeSharedWriteAccess(path: string): Promise<void> {
  const stats = await NodeFSP.lstat(path);
  if (stats.isSymbolicLink()) return;
  if (stats.mode & 0o022) await NodeFSP.chmod(path, stats.mode & 0o7755);
  if (!stats.isDirectory()) return;
  for (const entry of await NodeFSP.readdir(path)) {
    await removeSharedWriteAccess(NodePath.join(path, entry));
  }
}
