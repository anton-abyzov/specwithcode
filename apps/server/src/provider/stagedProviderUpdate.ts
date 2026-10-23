// @effect-diagnostics nodeBuiltinImport:off -- Installer boundary; only verified private provider files are accessed.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface StagedCodexUpdate {
  readonly wrapperPath: string;
  readonly expectedWrapper: string;
  readonly releasesDirectory: string;
  readonly nodePath: string;
  readonly npmCliPath: string;
}

/** No scripts, shell, global installs, auth homes, or old-release mutations. */
export async function stageCodexUpdate(
  input: StagedCodexUpdate,
  version: string,
  run: (command: string, args: readonly string[]) => Promise<string> = async (command, args) =>
    (await exec(command, [...args], { timeout: 240_000, maxBuffer: 64 * 1024 })).stdout,
) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Cannot verify the latest stable Codex version. Refresh Providers and retry.");
  const assertUnchanged = async () => {
    for (const target of [
      input.wrapperPath,
      input.releasesDirectory,
      input.nodePath,
      input.npmCliPath,
    ]) {
      if ((await fs.realpath(target)) !== target)
        throw new Error("Provider installation changed. Refresh Providers and retry.");
    }
    if ((await fs.readFile(input.wrapperPath, "utf8")) !== input.expectedWrapper)
      throw new Error("Provider wrapper changed. Refresh Providers and retry.");
  };
  await assertUnchanged();
  const stage = await fs.mkdtemp(path.join(input.releasesDirectory, `codex-${version}-`));
  await fs.chmod(stage, 0o700);
  await run(input.nodePath, [
    input.npmCliPath,
    "install",
    "--prefix",
    stage,
    "--ignore-scripts",
    "--save-exact",
    "--registry=https://registry.npmjs.org",
    `@openai/codex@${version}`,
  ]);
  const packageDirectory = path.join(stage, "node_modules/@openai/codex");
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  if (manifest.name !== "@openai/codex" || manifest.version !== version)
    throw new Error(
      "The staged Codex package did not match the requested version. Existing installation preserved.",
    );
  const entrypoint = path.join(packageDirectory, "bin/codex.js");
  if ((await fs.realpath(entrypoint)) !== entrypoint)
    throw new Error("The staged Codex entrypoint is redirected. Existing installation preserved.");
  const output = (await run(input.nodePath, [entrypoint, "--version"])).trim();
  if (output !== `codex-cli ${version}`)
    throw new Error(
      `The staged Codex executable reported ${JSON.stringify(output)}. Existing installation preserved.`,
    );
  await assertUnchanged();
  const next = `#!/bin/sh\nset -eu\nexec ${input.nodePath} ${entrypoint} "$@"\n`;
  const temporary = path.join(
    path.dirname(input.wrapperPath),
    `.codex-update-${path.basename(stage)}`,
  );
  await fs.writeFile(temporary, next, { mode: 0o700, flag: "wx" });
  try {
    await assertUnchanged();
    await fs.rename(temporary, input.wrapperPath);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return `Verified Codex ${version}. New sessions use the update; existing release files were preserved.`;
}

/** Exact configured paths and package identities also catch renamed and Node entrypoints. */
export function providerProcessesInUse(
  commands: string,
  provider: string,
  paths: readonly string[],
  packageName?: string,
): boolean {
  const name = provider === "claudeAgent" ? "claude" : provider;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = new RegExp(`(?:^|[/\\s])${escape(name)}(?:[.\\s/]|$)`, "i");
  return commands
    .split("\n")
    .some(
      (command) =>
        names.test(command) ||
        paths.some((target) => command.includes(target)) ||
        (!!packageName && command.includes(`/node_modules/${packageName}/`)),
    );
}
export async function assertProviderInstallerIdle(
  provider: string,
  paths: readonly string[] = [],
  packageName?: string,
) {
  const name = provider === "claudeAgent" ? "claude" : provider;
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || process.platform === "win32")
    throw new Error(
      "Cannot verify that this installer is idle. Update with its owning installer after closing provider sessions.",
    );
  const { stdout } = await exec("/bin/ps", ["-axww", "-o", "command="], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (providerProcessesInUse(stdout, provider, paths, packageName))
    throw new Error(
      `${name} is in use. Retry after its sessions finish; no processes were stopped.`,
    );
}
