import type { TeamRulesSummary } from "@specweave-studio/contracts";
import { teamRulesSetByLabel } from "@specweave-studio/shared/teamRules";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { teamRulesRows } from "../../../state/teamRules";
import { SettingsSection } from "./SettingsSection";

function Row(props: {
  readonly title: string;
  readonly value: string;
  readonly separated: boolean;
  readonly selectable?: boolean;
}) {
  return (
    <View className={props.separated ? "gap-1 border-t border-border-subtle p-4" : "gap-1 p-4"}>
      <Text className="text-base text-foreground">{props.title}</Text>
      <Text selectable={props.selectable === true} className="text-sm text-foreground-muted">
        {props.value}
      </Text>
    </View>
  );
}

/** What a machine's rules set and who to ask. Callers render nothing on a machine without them. */
export function TeamRulesSection(props: {
  readonly summary: TeamRulesSummary;
  readonly environmentLabel?: string;
}) {
  const { summary } = props;
  const title =
    props.environmentLabel === undefined ? "Team rules" : `Team rules · ${props.environmentLabel}`;
  const setBy = teamRulesSetByLabel(summary.owner);
  const contact = summary.contact === undefined ? "" : ` See ${summary.contact}.`;
  if (summary.status === "hold") {
    return (
      <SettingsSection title={title}>
        <Row
          title="Agents are paused"
          selectable
          separated={false}
          value={`${setBy}. The team rules file has an error, so no agent turn can start on this machine. Fixing the file resumes agents without a restart.${contact}`}
        />
        {(summary.issues ?? []).map((issue) => (
          <Row key={issue} title="Error" selectable separated value={issue} />
        ))}
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title={title}>
      <Row
        title={setBy}
        selectable
        separated={false}
        value={`Your own choices come back if the rules are removed.${contact}`}
      />
      {teamRulesRows(summary).map((row) => (
        <Row key={row.title} title={row.title} value={row.value} separated />
      ))}
    </SettingsSection>
  );
}
