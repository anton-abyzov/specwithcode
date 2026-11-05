import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import type { EnvironmentId, TeamRulesSummary } from "@specweave-studio/contracts";
import { teamRulesSetByLabel } from "@specweave-studio/shared/teamRules";

import { teamRulesRows } from "../../teamRules/teamRulesView";
import { useTeamRules } from "../../teamRules/useTeamRules";
import { SettingsRow, SettingsSection, TeamRulesLabel } from "./settingsLayout";

/** Rules files are admin text, so only an https address becomes a link. */
function Contact({ contact }: { readonly contact: string }) {
  return /^https:\/\//iu.test(contact) ? (
    <a href={contact} target="_blank" rel="noopener noreferrer" className="underline">
      {contact}
    </a>
  ) : (
    <>{contact}</>
  );
}

export function TeamRulesSectionView({ summary }: { readonly summary: TeamRulesSummary }) {
  const tx = useTx();
  const setBy = teamRulesSetByLabel(summary.owner);
  if (summary.status === "hold") {
    return (
      <SettingsSection id="team-rules" title="Team rules">
        <SettingsRow
          title="Agents are paused"
          status={<TeamRulesLabel>{setBy}</TeamRulesLabel>}
          description={
            <>
              {renderRich(
                tx(
                  "The team rules file has an error, so no agent turn can start on this machine. Fixing the file resumes agents without a restart.{value}",
                ),
                {
                  value:
                    summary.contact === undefined ? null : (
                      <>
                        {renderRich(tx("See {contact}."), {
                          contact: <Contact contact={summary.contact} />,
                        })}
                      </>
                    ),
                },
              )}
            </>
          }
        />
        {(summary.issues ?? []).map((issue) => (
          <SettingsRow key={issue} title="Error" description={<code>{issue}</code>} />
        ))}
      </SettingsSection>
    );
  }
  return (
    <SettingsSection id="team-rules" title="Team rules">
      <SettingsRow
        title={setBy}
        literal
        description={
          <>
            {renderRich(tx("{value}Your own choices come back if the rules are removed."), {
              value:
                summary.contact === undefined ? null : (
                  <>
                    {renderRich(tx("Why this is locked: {contact}."), {
                      contact: <Contact contact={summary.contact} />,
                    })}
                  </>
                ),
            })}
          </>
        }
      />
      {teamRulesRows(summary).map((row) => (
        <SettingsRow key={row.title} title={row.title} description={row.value} literal />
      ))}
    </SettingsSection>
  );
}

/** Takes no space, and adds no navigation, on a machine without rules. */
export function TeamRulesSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const { summary } = useTeamRules(environmentId);
  return summary === undefined ? null : <TeamRulesSectionView summary={summary} />;
}
