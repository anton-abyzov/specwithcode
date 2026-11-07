import { useTx } from "../../i18n";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import {
  projectSettingsOverrideChangesPatch,
  resolveProjectSettings,
} from "@specweave-studio/shared/projectSettings";
import { GitBranchIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useEnvironmentSettings, useProjectOverrideWriteMode } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

/**
 * Shown under a command or tool refused a worktree because the project's Use
 * worktrees switch is off. One click turns the project's own switch on, the same
 * setting as its General tab; the agent's next turn may then make the worktree.
 */
export function UseWorktreesCard({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const tx = useTx();
  const settings = useEnvironmentSettings(environmentId);
  const writeMode = useProjectOverrideWriteMode(environmentId);
  const allowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const resolved = resolveProjectSettings(settings, projectId);
  const on =
    resolved.sources.defaultThreadEnvMode === "project" &&
    resolved.settings.defaultThreadEnvMode === "worktree";
  async function turnOn() {
    if (!allowed || inFlight.current || writeMode === null) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await save({
        environmentId,
        input: {
          // Only this key: the project's other overrides stay as saved.
          patch: projectSettingsOverrideChangesPatch(
            settings,
            { [projectId]: { set: { defaultThreadEnvMode: "worktree" } } },
            writeMode === "per-key",
          ),
        },
      });
      if (result._tag === "Failure") setError(tx("Could not turn on Use worktrees. Try again."));
    } catch {
      setError(tx("Could not turn on Use worktrees. Try again."));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <div
      role="note"
      data-testid="use-worktrees-card"
      data-use-worktrees={on ? "on" : "off"}
      className="my-1 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/6 px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <GitBranchIcon className="size-4 shrink-0 text-warning-foreground" />
        <div className="min-w-0 text-sm">
          <p className="font-medium">
            {on
              ? tx("Use worktrees is on for this project")
              : tx("Use worktrees is off for this project")}
          </p>
          <p className="text-muted-foreground">
            {on
              ? tx("The agent can now move into its own worktree. Send it a message to continue.")
              : tx(
                  "The agent kept working in this checkout. Turn it on to let threads in this project use their own git worktree.",
                )}
          </p>
          {error ? <p className="text-destructive">{error}</p> : null}
        </div>
      </div>
      {on ? null : (
        <Button
          size="sm"
          variant="outline"
          disabled={!allowed || pending || writeMode === null}
          aria-busy={pending}
          onClick={() => void turnOn()}
        >
          {tx("Turn on Use worktrees for this project")}
        </Button>
      )}
    </div>
  );
}
