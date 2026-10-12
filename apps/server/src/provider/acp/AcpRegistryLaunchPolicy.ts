/** Verified native ACP launchers must stay at the version prepared by Studio. */
export function acpRegistryLaunchArgs(
  agentId: string,
  packageSpec: string | undefined,
  args: ReadonlyArray<string>,
) {
  const knownPackage =
    (agentId === "github-copilot-cli" && packageSpec?.startsWith("@github/copilot@")) ||
    (agentId === "grok-build" && packageSpec?.startsWith("@xai-official/grok@"));
  return knownPackage && !args.includes("--no-auto-update") ? ["--no-auto-update", ...args] : args;
}

/** Grok's npm postinstall otherwise rewires the user's ~/.grok/bin and config. */
export function acpRegistryInstallEnvironment(
  packageSpec: string,
  environment: NodeJS.ProcessEnv,
  managedGrokHome: string,
): NodeJS.ProcessEnv {
  return packageSpec.startsWith("@xai-official/grok@")
    ? { ...environment, GROK_HOME: managedGrokHome, GROK_INSTALL_COMPLETIONS: "0" }
    : environment;
}
