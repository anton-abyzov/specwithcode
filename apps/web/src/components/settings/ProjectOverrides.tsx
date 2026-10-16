import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { AuthSettingsWriteScope } from "@specweave-studio/contracts";
import { useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { Button } from "../ui/button";
import { listProjectSettingOverrides } from "./projectOverrideRows";
import { planProjectOverridesClear } from "./scopedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useRunScopedPlan } from "./useScopedSettings";

/**
 * The values this project sets for itself instead of the app settings.
 * Renders nothing when the project follows the app settings everywhere.
 */
export function ProjectOverrides({
  checkouts,
}: {
  checkouts: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[];
}) {
  const { environments } = useEnvironments();
  const rows = useMemo(
    () => listProjectSettingOverrides(checkouts, environments),
    [checkouts, environments],
  );
  const environmentKey = [...new Set(rows.map((row) => row.environmentId))].join("\n");
  const rowEnvironments = useMemo(
    () =>
      environmentKey === ""
        ? []
        : environmentKey.split("\n").map((id) => ({ environmentId: id as EnvironmentId })),
    [environmentKey],
  );
  const writable = useEnvironmentsWithScope(rowEnvironments, AuthSettingsWriteScope);
  const run = useRunScopedPlan();
  if (rows.length === 0) return null;
  const showMachine = new Set(rows.map((row) => row.environmentId)).size > 1;
  return (
    <SettingsSection id="project-overrides" title="Overrides">
      {rows.map((row) => (
        <SettingsRow
          key={`${row.environmentId}:${row.projectId}:${row.key}`}
          data-override-key={row.key}
          title={row.label}
          description={`${row.value} for this project${showMachine ? ` on ${row.environmentLabel}` : ""}. ${row.appValue === "Same" ? `Same as the app setting (${row.page}).` : `App setting (${row.page}): ${row.appValue}.`}`}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!writable.has(row.environmentId)}
              aria-label={`Use the app setting for ${row.label}`}
              onClick={() =>
                run(
                  planProjectOverridesClear(
                    environments,
                    [{ environmentId: row.environmentId, projectId: row.projectId }],
                    [row.key],
                  ),
                )
              }
            >
              Use app setting
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
