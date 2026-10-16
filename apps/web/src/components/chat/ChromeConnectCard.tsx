import type { EnvironmentId } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { ChromeIcon } from "lucide-react";
import { useEnvironment } from "../../state/environments";
import { Button } from "../ui/button";

/** Shown under a browser tool that failed because Chrome's extension was unreachable. */
export function ChromeConnectCard({ environmentId }: { environmentId: EnvironmentId }) {
  const machine = useEnvironment(environmentId)?.label ?? "this machine";
  return (
    <div
      role="note"
      data-testid="chrome-connect-card"
      className="my-1 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/6 px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <ChromeIcon className="size-4 shrink-0 text-warning-foreground" />
        <div className="min-w-0 text-sm">
          <p className="font-medium">Chrome is not connected on {machine}</p>
          <p className="text-muted-foreground">
            Test the connection or reconnect the extension, then ask the agent to try again.
          </p>
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        render={<Link to="/settings/chrome" search={{ machine: environmentId }} />}
      >
        Connect Chrome on {machine}
      </Button>
    </div>
  );
}
