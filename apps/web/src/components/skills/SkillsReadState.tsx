import type { ProjectSkillsSnapshot } from "@specweave-studio/contracts";

import { useTx } from "../../i18n";
import { projectSkillReadLines } from "../settings/ProjectSkillsSettings.logic";

/**
 * Above the Skills table: which machine answered and when, then one line per
 * agent whose answer has a limit. A skill missing for an agent listed here as
 * not fully read is unknown, not absent.
 */
export function SkillsReadState({
  snapshot,
  machine,
}: {
  snapshot: Pick<ProjectSkillsSnapshot, "providers" | "rows" | "checkedAt">;
  machine: string;
}) {
  const tx = useTx();
  const lines = projectSkillReadLines(snapshot);
  const at = new Date(snapshot.checkedAt);
  const time = Number.isNaN(at.getTime())
    ? null
    : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const partial = lines.some((line) => line.kind === "partial");
  return (
    <div
      className="space-y-1 text-xs text-muted-foreground"
      data-testid="skills-read-state"
      data-partial={partial ? "true" : "false"}
    >
      <p>
        {time
          ? tx("Read on {machine} at {time}.", { machine, time })
          : tx("Read on {machine}.", { machine })}{" "}
        {partial
          ? tx("Not every agent was read in full, so a skill missing below is not always absent:")
          : tx("Every agent answered.")}
      </p>
      {lines.length > 0 ? (
        <ul className="space-y-0.5">
          {lines.map((line) => (
            <li
              key={line.instanceId}
              data-read-kind={line.kind}
              className={line.kind === "partial" ? "text-warning-foreground" : undefined}
            >
              <span className="font-medium text-foreground">{line.label}</span>
              {": "}
              {line.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
