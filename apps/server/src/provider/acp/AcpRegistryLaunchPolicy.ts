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

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

// Only a sign-in refusal: E403/E404 can be a mirror's deliberate package block.
const NPM_REGISTRY_REFUSAL = /\bnpm (?:ERR!|error) code (?:E401|ENEEDAUTH)\b/u;

/**
 * ACP Registry npm agents are published on the public registry. A default
 * registry pointed at a private feed with an expired sign-in refuses them, so
 * such an install is retried once against npmjs.
 */
export function shouldRetryOnPublicNpmRegistry(
  failureDetail: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (environment.npm_config_registry === PUBLIC_NPM_REGISTRY) return false;
  if (!NPM_REGISTRY_REFUSAL.test(failureDetail)) return false;
  return !failureDetail.includes("registry.npmjs.org");
}
