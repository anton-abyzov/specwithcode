// @effect-diagnostics nodeBuiltinImport:off - platform-aware paths in a retained context mapping.
import * as NodePath from "node:path";
import type { MachineHandoffBundle } from "@specweave-studio/contracts";

/** Historical text stays byte-for-byte; structured paths get an explicit local counterpart. */
export function copiedContextPaths(
  bundle: MachineHandoffBundle,
  destinationProjectRoot: string,
  platform: NodeJS.Platform = process.platform,
) {
  const destinationPath = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const scope = bundle.manifest.copyScope;
  if (!scope) return null;
  const depth = scope.projectRelativePath === "." ? 0 : scope.projectRelativePath.split("/").length;
  const destinationCopyRoot = destinationPath.resolve(
    destinationProjectRoot,
    ...Array<string>(depth).fill(".."),
  );
  const sourcePath = /^[a-z]:[\\/]/i.test(scope.copyRoot) ? NodePath.win32 : NodePath.posix;
  const sourceProjectRoot = sourcePath.resolve(scope.copyRoot, scope.projectRelativePath);
  return {
    sourceCopyRoot: scope.copyRoot,
    destinationCopyRoot,
    sourceProjectRoot,
    destinationProjectRoot,
    threads: bundle.context.threads.map((thread) => {
      const sourceWorktreePath = thread.worktreePath;
      const sourceLocal =
        thread.environmentId === undefined || thread.environmentId === bundle.sourceEnvironmentId;
      const relative =
        sourceLocal && sourceWorktreePath !== null
          ? sourcePath.relative(scope.copyRoot, sourceWorktreePath)
          : null;
      const included =
        sourceLocal &&
        (sourceWorktreePath === null ||
          (relative !== null &&
            relative !== ".." &&
            !relative.startsWith(`..${sourcePath.sep}`) &&
            !sourcePath.isAbsolute(relative)));
      const repositoryPath = relative?.split(sourcePath.sep).join("/") || ".";
      const mapped =
        included &&
        (sourceWorktreePath === null ||
          bundle.manifest.repositories.some(
            (repository) => repository.relativePath === repositoryPath,
          ));
      return {
        threadId: thread.threadId,
        sourceWorktreePath,
        destinationWorktreePath: mapped
          ? sourceWorktreePath === null
            ? destinationProjectRoot
            : destinationPath.join(destinationCopyRoot, ...relative!.split(sourcePath.sep))
          : null,
        copied: mapped,
      };
    }),
  };
}
