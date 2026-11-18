import { useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestMachineToolInstall } from "../machineTools/machineToolInstallRequest";
import { Button } from "../ui/button";
import { SPECWEAVE_SETUP_DESCRIPTION } from "./ProjectCreation";

/** What the Git half of "Set up Git and SpecWeave" does, before the SpecWeave list. */
export const GIT_SETUP_DESCRIPTION =
  "This folder is not a Git repository yet, so this first runs git init here; none of your files are added or committed.";

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Project settings' SpecWeave row. SpecWeave is on when the folder was set up
 * with `specweave init`, read from disk; off means the app's own plan and
 * memory are used and nothing is added to the repository. Turning it on runs
 * `specweave init` after the person confirms the files it adds; nothing is
 * committed for them. A folder that is not a Git repository yet gets
 * `git init` first, from the same one click ("Set up Git and SpecWeave").
 */
export function ProjectSpecweaveSetting({
  project,
  specweave,
  gitRepository,
  disabled,
  onChanged,
}: {
  project: Pick<EnvironmentProject, "environmentId" | "id">;
  /** From the workspace read; undefined when the server is too old to say. */
  specweave: boolean | undefined;
  /** The folder is in a Git work tree; false offers Git with SpecWeave. Undefined from older servers. */
  gitRepository?: boolean | undefined;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The machine has no Node.js: the install is offered right under the reason.
  const [needsNode, setNeedsNode] = useState(false);
  const setUp = useAtomCommand(projectWorkspace.specweaveSetUp);
  if (specweave === undefined) return null;
  const withGit = gitRepository === false;

  async function run() {
    if (disabled || busy) return;
    setBusy(true);
    setError(null);
    setNeedsNode(false);
    const result = await setUp({
      environmentId: project.environmentId,
      input: { projectId: project.id, ...(withGit ? { initGit: true } : {}) },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "SpecWeave could not be set up.");
      setNeedsNode(
        typeof cause === "object" && cause !== null && "needs" in cause && cause.needs === "node",
      );
      return;
    }
    setConfirming(false);
    onChanged();
  }

  return (
    <div className="project-setting-row">
      <div>
        <h3>SpecWeave</h3>
        <p className="project-muted">
          {specweave
            ? "On. Threads plan work as SpecWeave increments, with specs, tasks and handoffs kept in the repository."
            : "Off. SpecWithCode's own plan and memory are used, and nothing is added to your repository."}
        </p>
        {confirming && !specweave ? (
          <p className="project-muted">
            {withGit
              ? `${GIT_SETUP_DESCRIPTION} Then it ${lowerFirst(SPECWEAVE_SETUP_DESCRIPTION)}`
              : SPECWEAVE_SETUP_DESCRIPTION}
            . The changes are left for you to review and commit.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="project-muted text-destructive-foreground">
            {needsNode
              ? "SpecWeave needs Node.js, which this machine does not have. Install it here, then run specweave init again."
              : error}
          </p>
        ) : null}
        {needsNode ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              requestMachineToolInstall({
                environmentId: project.environmentId,
                tool: "node",
                machineLabel: null,
              })
            }
          >
            Install Node.js
          </Button>
        ) : null}
      </div>
      {specweave ? null : confirming ? (
        <div className="project-actions">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={disabled || busy} onClick={() => void run()}>
            {busy ? "Setting up…" : withGit ? "Set up Git and SpecWeave" : "Run specweave init"}
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => setConfirming(true)}>
          {withGit ? "Set up Git and SpecWeave" : "Set up SpecWeave"}
        </Button>
      )}
    </div>
  );
}
