/** These featured providers must only install or update after an explicit setup action. */
export function requiresExplicitAcpPreparation(agentId: string, packageSpec?: string): boolean {
  return (
    (agentId === "github-copilot-cli" && packageSpec?.startsWith("@github/copilot@") === true) ||
    (agentId === "grok-build" && packageSpec?.startsWith("@xai-official/grok@") === true)
  );
}
