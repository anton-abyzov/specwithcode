/**
 * Install / update agent for GitHub Copilot, offered right in the sign-in step
 * when sign-in failed because Copilot CLI is missing, too old or unreadable.
 * The same action as Settings > Providers (AcpRegistryRepair), so a fresh
 * machine can finish setup without leaving the dialog.
 */
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useRef, useState } from "react";

import { useTx } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { COPILOT_ACP_AGENT_ID } from "./AddProviderInstanceDialog.logic";

export function CopilotInstallAgentButton({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const tx = useTx();
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const prepare = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ error: boolean; message: string } | null>(null);
  const active = useRef(false);

  const install = async () => {
    if (active.current || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    active.current = true;
    setPending(true);
    setResult(null);
    try {
      const prepared = await prepare({
        environmentId,
        input: { agentId: COPILOT_ACP_AGENT_ID },
      });
      if (prepared._tag === "Failure") {
        if (isAtomCommandInterrupted(prepared)) return;
        const error = squashAtomCommandFailure(prepared);
        setResult({
          error: true,
          message:
            error instanceof Error
              ? error.message
              : "Installation did not finish. Retry Install / update agent.",
        });
        return;
      }
      const refreshed = await refresh({
        environmentId,
        input: { instanceId, refreshModels: true },
      });
      setResult(
        refreshed._tag === "Failure"
          ? {
              error: true,
              message:
                "Copilot CLI installed, but provider status could not refresh. Retry sign-in.",
            }
          : {
              error: false,
              message: `Copilot CLI ${prepared.value.version} installed. Use Retry sign-in.`,
            },
      );
    } catch {
      setResult({
        error: true,
        message: "Installation could not finish. Check the machine connection and retry.",
      });
    } finally {
      active.current = false;
      setPending(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={!canManage || pending}
        onClick={() => void install()}
      >
        {pending ? tx("Installing…") : tx("Install / update agent")}
      </Button>
      {result ? (
        <span
          role="status"
          className={result.error ? "text-destructive-foreground" : "text-muted-foreground"}
        >
          {result.message}
        </span>
      ) : null}
    </div>
  );
}
