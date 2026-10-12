import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { FEATURED_ACP_AGENT_IDS } from "./FeaturedAcpProviders";

export function repairableAcpRegistryAgentId(instance: ProviderInstanceConfig): string | null {
  if (instance.driver !== "acpRegistry" || !instance.config || typeof instance.config !== "object")
    return null;
  const config = instance.config as Record<string, unknown>;
  if (config.source !== undefined && config.source !== "registry") return null;
  if (typeof config.commandPath === "string" && config.commandPath.trim()) return null;
  return FEATURED_ACP_AGENT_IDS.find((id) => id === config.agentId) ?? null;
}

/** Explicit package preparation; opening Settings never installs or changes an account. */
export function AcpRegistryRepair({
  environmentId,
  instanceId,
  instance,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly readOnly: boolean;
}) {
  const agentId = repairableAcpRegistryAgentId(instance);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const prepare = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{
    readonly error: boolean;
    readonly message: string;
  } | null>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const target = `${environmentId}:${instanceId}:${agentId ?? "unmanaged"}`;
  const currentTarget = useRef(target);
  currentTarget.current = target;
  useEffect(() => {
    setPending(false);
    setResult(null);
    return () => {
      generation.current += 1;
      active.current = false;
    };
  }, [target]);

  const install = async () => {
    if (
      !agentId ||
      readOnly ||
      active.current ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope)
    )
      return;
    const operation = ++generation.current;
    const isCurrent = () => generation.current === operation && currentTarget.current === target;
    active.current = true;
    setPending(true);
    setResult(null);
    try {
      const prepared = await prepare({ environmentId, input: { agentId } });
      if (!isCurrent()) return;
      if (prepared._tag === "Failure") {
        const error = isAtomCommandInterrupted(prepared)
          ? null
          : squashAtomCommandFailure(prepared);
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
      if (!isCurrent()) return;
      if (refreshed._tag === "Failure") {
        setResult({
          error: true,
          message:
            "Agent installed, but provider status could not refresh. Retry Install / update agent or refresh provider status.",
        });
        return;
      }
      setResult({
        error: false,
        message: `Agent v${prepared.value.version} installed. Provider status refreshed; sign in below if required.`,
      });
    } catch {
      if (isCurrent())
        setResult({
          error: true,
          message: "Installation could not finish. Check the environment connection and retry.",
        });
    } finally {
      if (isCurrent()) {
        active.current = false;
        setPending(false);
      }
    }
  };

  if (!agentId) return null;
  return (
    <div>
      <SettingsRow
        title="Agent installation"
        description="Install or update the official registry agent on this environment. Your provider settings and sign-in are kept."
        control={
          <Button
            onClick={() => void install()}
            disabled={readOnly || !canManage || pending}
            size="sm"
            variant="outline"
          >
            {pending ? "Installing…" : "Install / update agent"}
          </Button>
        }
      />
      {result ? (
        <p
          role="status"
          className={
            result.error
              ? "px-4 pb-3 text-xs text-destructive"
              : "px-4 pb-3 text-xs text-muted-foreground"
          }
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
