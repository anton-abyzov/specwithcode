/**
 * Adding a project to another machine copies its files and the secrets the
 * person picks, never the tools: Git, Node.js and SpecWeave live on each
 * machine. This checks the destination while the person prepares the copy and,
 * when something is missing there, shows that machine's rows with Install.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";

import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { MachineBasicsOn } from "../onboarding/MachineBasics";
import { machineToolStatus, useMachineTools } from "./machineToolsUi";

const NEEDED = ["git", "node", "specweave"] as const;

export function DestinationReadiness({
  environmentId,
  machineName,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineName: string;
}) {
  const tx = useTx();
  const { state } = useMachineTools(environmentId);
  if (state.kind !== "ready") return null;
  const short = NEEDED.some((tool) => {
    const status = machineToolStatus(state.check, tool);
    return status !== null && (status.presence === "missing" || status.outdated);
  });
  if (!short) return null;
  return (
    <section
      className="rounded-md border border-warning/40 p-3 text-sm"
      data-slot="destination-readiness"
    >
      <p className="mb-2">
        {renderRich(
          tx(
            "Tools stay on each machine and are not copied. {machineName} still needs some before agents can work on this project there.",
          ),
          { machineName },
        )}
      </p>
      <MachineBasicsOn environmentId={environmentId} />
    </section>
  );
}
