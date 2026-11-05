import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import type {
  DecisionModelProvider,
  DecisionModelSettings as DecisionModelValue,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { teamRulesProviderAllowed } from "@specweave-studio/shared/teamRules";
import { teamRulesDecisionModelLock } from "../../teamRules/teamRulesView";
import { useTeamRules } from "../../teamRules/useTeamRules";
import { SettingsRow, TeamRulesLabel } from "./settingsLayout";

export const DECISION_PROVIDER_OPTIONS: ReadonlyArray<{
  readonly value: DecisionModelProvider;
  readonly label: string;
  readonly keysUrl?: string;
}> = [
  { value: "off", label: "Off" },
  { value: "openrouter", label: "OpenRouter", keysUrl: "https://openrouter.ai/settings/keys" },
  { value: "typesafe", label: "TypeSafe", keysUrl: "https://typesafe.ai" },
];

type DecisionModelPatch = Partial<Pick<DecisionModelValue, "provider" | "apiKey">>;

/**
 * The patch for one change on this section. Moving from one provider to the
 * other drops the saved key, which belongs to the first; turning the decision
 * model off and on again keeps it.
 */
export function decisionModelPatch(input: {
  readonly saved: DecisionModelValue;
  readonly provider?: DecisionModelProvider;
  readonly key?: string;
  readonly removeKey?: boolean;
}): DecisionModelPatch {
  if (input.removeKey === true) return { apiKey: "" };
  const key = input.key?.trim() ?? "";
  const switching =
    input.provider !== undefined &&
    input.provider !== "off" &&
    input.saved.provider !== "off" &&
    input.provider !== input.saved.provider;
  return {
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    // An omitted key keeps the saved one; an empty one removes it.
    ...(key.length > 0 ? { apiKey: key } : switching ? { apiKey: "" } : {}),
  };
}

/**
 * The decision model for this machine: Jev, from TypeSafe, which picks one of
 * a fixed list of options in well under a second, reached through OpenRouter
 * or TypeSafe as `specweave jev` does. The key is write-only here; the server
 * keeps it in its secret store and only reports whether one is set.
 */
export function DecisionModelSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly readOnly?: boolean;
}) {
  const tx = useTx();
  const saved = useEnvironmentSettings(props.environmentId, (settings) => settings.decisionModel);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const [key, setKey] = useState("");
  const teamRules = useTeamRules(props.environmentId);
  const teamLock = teamRulesDecisionModelLock(teamRules.summary, saved.provider, saved.model);
  const hasKey = saved.apiKey.length > 0;
  const provider = DECISION_PROVIDER_OPTIONS.find((option) => option.value === saved.provider);
  const apply = (input: Omit<Parameters<typeof decisionModelPatch>[0], "saved">) => {
    updateSettings({ decisionModel: decisionModelPatch({ saved, ...input }) });
    if (input.key !== undefined) setKey("");
  };
  return (
    <div className="flex flex-col">
      <SettingsRow
        id="decision-model-provider"
        title="Use Jev for decisions"
        status={teamLock !== null ? <TeamRulesLabel>{teamLock}</TeamRulesLabel> : undefined}
        description={
          <>
            {tx(
              "Jev, from TypeSafe, picks one option from a fixed list in well under a second and costs almost nothing. When the coordinator does not say whether a task is complex or routine, Jev picks the lane, and it settles the kind of work when the keyword rules are unsure. The coordinator can also ask it any multiple-choice question. If Jev is slow or unreachable, routing keeps the rules' answer.",
            )}
          </>
        }
        control={
          <Select
            value={saved.provider}
            disabled={props.readOnly}
            onValueChange={(value) => {
              if (value !== null) apply({ provider: value as DecisionModelProvider });
            }}
          >
            <SelectTrigger aria-label={tx("Decision model provider")} className="w-36" size="sm">
              <SelectValue>{provider?.label ?? tx("Off")}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {DECISION_PROVIDER_OPTIONS.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  disabled={
                    option.value !== "off" &&
                    !teamRulesProviderAllowed(teamRules.state, option.value)
                  }
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {saved.provider === "off" || provider === undefined ? null : (
        <SettingsRow
          id="decision-model-key"
          title={`${provider.label} API key`}
          description={
            hasKey ? (
              "A key is saved on this machine. Enter a new one to replace it."
            ) : (
              <>
                {renderRich(
                  tx(
                    "Jev answers once a key is saved. Create one at {a}. It stays in this machine's secret store and is only sent to {label}.",
                  ),
                  {
                    a: (
                      <a
                        href={provider.keysUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        {provider.label}
                      </a>
                    ),
                    label: provider.label,
                  },
                )}
              </>
            )
          }
          control={
            <div className="flex items-center gap-2">
              <Input
                aria-label={`${provider.label} API key`}
                type="password"
                autoComplete="off"
                placeholder={hasKey ? tx("Saved") : tx("API key")}
                value={key}
                disabled={props.readOnly}
                onChange={(event) => setKey(event.target.value)}
                className="w-48"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={props.readOnly || key.trim().length === 0}
                onClick={() => apply({ key })}
              >
                {tx("Save")}
              </Button>
              {hasKey ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.readOnly}
                  onClick={() => apply({ removeKey: true })}
                >
                  {tx("Remove")}
                </Button>
              ) : null}
            </div>
          }
        />
      )}
    </div>
  );
}
