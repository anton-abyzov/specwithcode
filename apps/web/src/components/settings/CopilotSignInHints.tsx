/**
 * What the GitHub Copilot sign-in step adds: the Copilot sign-ins that
 * machine already has (VS Code's Copilot extension, gh accounts, including an
 * enterprise host), found without reading any token, and an Install Node.js
 * button when Copilot CLI cannot run because the machine has no Node.js.
 */
import type { EnvironmentId, ProviderAuthState } from "@specweave-studio/contracts";
import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { requestMachineToolInstall } from "../machineTools/machineToolInstallRequest";
import { Button } from "../ui/button";

/** The start of the server's message for this cause (CopilotDeviceAuthentication.ts). */
export const COPILOT_NEEDS_NODE_PREFIX =
  "Copilot CLI runs on Node.js, which this machine does not have.";

export function copilotNeedsNode(message: string | null | undefined): boolean {
  return message?.startsWith(COPILOT_NEEDS_NODE_PREFIX) === true;
}

export function CopilotSignInHints({
  environmentId,
  environmentLabel,
  found,
  message,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /** What the server found on that machine (only this, never the sign-in state with its code). */
  readonly found: ProviderAuthState["copilotExistingSignIns"] | undefined;
  /** The failure shown above, if any. */
  readonly message: string | null;
  readonly readOnly: boolean;
}) {
  const tx = useTx();
  const needsNode = copilotNeedsNode(message);
  // The host device sign-in goes to: one enterprise host and no other, as on the server.
  const hosts = [...new Set(found?.ghAccounts.map((account) => account.host) ?? [])];
  const enterprise = hosts.length === 1 && hosts[0] !== "github.com" ? hosts : [];
  if (
    !needsNode &&
    (found === undefined || (!found.vscodeCopilot && found.ghAccounts.length === 0))
  )
    return null;
  return (
    <div className="my-2 grid gap-2 text-xs" data-copilot-sign-in-hints>
      {needsNode && !readOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              requestMachineToolInstall({
                environmentId,
                tool: "node",
                machineLabel: environmentLabel,
                neededBy: "copilot",
              })
            }
          >
            {tx("Install {tool}", { tool: "Node.js" })}
          </Button>
        </div>
      ) : null}
      {found !== undefined && (found.vscodeCopilot || found.ghAccounts.length > 0) ? (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-muted-foreground">
          <p className="font-medium text-foreground">
            {renderRich(tx("Already on {environmentLabel}"), { environmentLabel })}
          </p>
          <ul className="mt-1 list-disc ps-4">
            {found.vscodeCopilot ? <li>{tx("GitHub Copilot in VS Code")}</li> : null}
            {found.ghAccounts.map((account) => (
              <li key={`${account.host}/${account.account}`}>
                {tx("GitHub CLI signed in as {account} on {host}", account)}
              </li>
            ))}
          </ul>
          <p className="mt-1">
            {enterprise.length === 1
              ? tx(
                  "Copilot CLI keeps its own sign-in. Sign in once with the same account; the code goes to {host}.",
                  { host: enterprise[0]! },
                )
              : tx(
                  "Copilot CLI keeps its own sign-in, and SpecWithCode never copies another app's. Sign in once with the same account.",
                )}
          </p>
        </div>
      ) : null}
    </div>
  );
}
