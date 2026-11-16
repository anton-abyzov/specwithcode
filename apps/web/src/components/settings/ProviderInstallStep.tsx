import { ExternalLinkIcon } from "lucide-react";

import { useTx } from "../../i18n";
import { CommandBox } from "../onboarding/AgentRow";
import { Button } from "../ui/button";

/**
 * How to install the selected agent, under its status row while it is not
 * installed: what to run on which machine, a Copy button, and a button that
 * runs it in the setup terminal on that machine. A machine that reports what it
 * found of the command also looks again by itself, so the row says so; an
 * older one is read again with Check again.
 */
export function ProviderInstallStep({
  agentName,
  machine,
  command,
  cli,
  documentationUrl,
  runDisabled,
  canRun,
  explained,
  onRun,
}: {
  readonly agentName: string;
  readonly machine: string;
  /** The agent's installer for its machine's system, or null when none is known. */
  readonly command: string | null;
  /** What the machine found of the command, or null from an older machine. */
  readonly cli: "missing" | "broken" | null;
  readonly documentationUrl: string | undefined;
  readonly runDisabled: boolean;
  /** False over a connection that cannot run anything: the command stays to copy. */
  readonly canRun: boolean;
  /** The row above already says what went wrong and what to do, in the machine's words. */
  readonly explained: boolean;
  readonly onRun: (command: string) => void;
}) {
  const tx = useTx();
  return (
    // One shrinkable column, so a long command scrolls in its box instead of widening the row.
    <div
      className="grid max-w-xl grid-cols-1 gap-2 text-xs"
      data-agent-install-step={cli ?? "unreported"}
    >
      {command === null ? (
        <>
          <p>
            {tx("Install {agent} on {machine} from its own site.", {
              agent: agentName,
              machine,
            })}
          </p>
          {documentationUrl ? (
            <Button
              render={<a href={documentationUrl} target="_blank" rel="noopener noreferrer" />}
              size="xs"
              variant="outline"
              className="w-fit"
            >
              <ExternalLinkIcon />
              {tx("Open its install guide")}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          {cli === "broken" && explained ? null : (
            <p>
              {cli === "broken"
                ? tx("Run its installer again:")
                : tx("Install {agent} on {machine} with this command:", {
                    agent: agentName,
                    machine,
                  })}
            </p>
          )}
          <CommandBox command={command} />
          {canRun ? (
            <Button
              size="sm"
              className="w-fit"
              disabled={runDisabled}
              onClick={() => onRun(command)}
            >
              {tx("Run in terminal")}
            </Button>
          ) : null}
        </>
      )}
      <p role="status" className="text-muted-foreground">
        {cli === null
          ? tx("After it installs, choose Check again.")
          : tx("Waiting for the install. This page updates by itself.")}
      </p>
    </div>
  );
}
