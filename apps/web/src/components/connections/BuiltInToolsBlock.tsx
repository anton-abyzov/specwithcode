import { AuthFilesystemReadScope, type EnvironmentId } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";

import { useTx } from "../../i18n";
import { useDeviceState } from "../../state/device";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { Badge } from "../ui/badge";
import {
  BUILT_IN_STATUS_LABEL,
  BUILT_IN_TOOLS,
  builtInToolStatus,
  type BuiltInToolFacts,
  type BuiltInToolStatus,
} from "./builtInTools";

const STATUS_VARIANT: Record<BuiltInToolStatus, "success" | "outline" | "warning"> = {
  on: "success",
  paired: "success",
  off: "outline",
  "mac-only": "outline",
  "needs-setup": "warning",
};

/** Reads what the selected machine reports about each built-in tool. */
function useBuiltInToolFacts(environmentId: EnvironmentId): BuiltInToolFacts {
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const mayRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const chrome = useEnvironmentQuery(
    mayRead && connected
      ? projectWorkspace.browserBridgeStatus({ environmentId, input: {} })
      : null,
  );
  const { state, loaded } = useDeviceState(environmentId);
  const config = environment?.serverConfig;
  return {
    os: config?.environment.platform.os,
    computerAccess: config?.settings.enableAgentComputerAccess,
    browserAccess: config?.settings.enableAgentBrowserAccess,
    deviceSupport: config?.settings.enableDeviceSupport,
    chromePaired: chrome.data ? chrome.data.extension.pairedBrowserName !== null : null,
    simulatorReady: loaded
      ? state.hosts.some(
          (host) => host.kind === "local" && host.platforms.some((platform) => platform.available),
        )
      : null,
  };
}

/** The list itself, apart from where its facts come from. */
export function BuiltInToolsList({ facts }: { readonly facts: BuiltInToolFacts }) {
  const tx = useTx();
  return (
    <section
      aria-labelledby="built-in-tools-title"
      className="space-y-2"
      data-testid="built-in-tools"
    >
      <div>
        <h3 id="built-in-tools-title" className="text-sm font-medium">
          {tx("Built into SpecWithCode")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {tx(
            "These are part of the app. You never add them as MCP servers, so they are not in the list below.",
          )}
        </p>
      </div>
      <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
        {BUILT_IN_TOOLS.map((tool) => {
          const status = builtInToolStatus(tool.id, facts);
          return (
            <li
              key={tool.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
              data-testid={`built-in-${tool.id}`}
            >
              <div className="min-w-40 flex-1">
                <p className="text-sm text-foreground">{tx(tool.name)}</p>
                <p className="text-xs text-muted-foreground">{tx(tool.line)}</p>
              </div>
              {status ? (
                <Badge variant={STATUS_VARIANT[status]} data-status={status}>
                  {tx(BUILT_IN_STATUS_LABEL[status])}
                </Badge>
              ) : null}
              <Link
                to={tool.to}
                hash={tool.hash}
                aria-label={`${tx(tool.link)}: ${tx(tool.name)}`}
                className="inline-flex min-h-8 items-center rounded-md px-1 text-sm text-foreground underline underline-offset-4 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
              >
                {tx(tool.link)}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Chrome, computer use, the in-app browser and simulators with their live
 * status on the selected machine and a link to where each is set up.
 */
export function BuiltInToolsBlock({ environmentId }: { readonly environmentId: EnvironmentId }) {
  return <BuiltInToolsList facts={useBuiltInToolFacts(environmentId)} />;
}
