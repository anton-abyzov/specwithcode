import { useId, useRef, useState } from "react";
import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  ClaudeWorkflowMode,
  DEFAULT_SERVER_SETTINGS,
  ResponseStyle,
} from "@specweave-studio/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { CharacterCount } from "../ui/character-count";
import { Textarea } from "../ui/textarea";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import {
  agentInstructionPreviews,
  instructionValuesAreMixed,
  previewAgentInstructions,
  type AgentInstructionPreview,
} from "./agentInstructionsSettings.logic";

const WORKFLOW_MODES = {
  disabled: "Disabled",
  "on-request": "On request",
  automatic: "Automatic",
} satisfies Record<ClaudeWorkflowMode, string>;

const RESPONSE_STYLES = {
  concise: "Concise",
  detailed: "Detailed",
} satisfies Record<ResponseStyle, string>;

function ResponseStyleSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["responseStyle"]);
  return (
    <SettingsSection title="Response style">
      <SettingsRow
        serverScoped
        settingKeys={["responseStyle"]}
        {...searchableSetting("response-style")}
        description="Concise agents lead with the result, keep replies to a few lines and send coordinators a short outcome, evidence and blockers instead of a replay of their steps. Detailed agents explain their steps. Errors, failing tests and security warnings stay complete either way."
        resetAction={
          mixed || settings.responseStyle !== DEFAULT_SERVER_SETTINGS.responseStyle ? (
            <SettingResetButton
              label="response style"
              onClick={() => update({ responseStyle: DEFAULT_SERVER_SETTINGS.responseStyle })}
            />
          ) : null
        }
        control={
          <Select
            value={mixed ? null : settings.responseStyle}
            onValueChange={(value) => {
              if (ResponseStyle.literals.includes(value as ResponseStyle))
                update({ responseStyle: value as ResponseStyle });
            }}
          >
            <SelectTrigger size="sm" aria-label="Response style">
              <SelectValue>
                {(value: ResponseStyle | null) =>
                  value === null ? "Mixed" : RESPONSE_STYLES[value]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {ResponseStyle.literals.map((style) => (
                <SelectItem key={style} value={style}>
                  {RESPONSE_STYLES[style]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <p className="px-3 pb-3 text-sm text-muted-foreground sm:px-4">
        Changes what coordinators, workers and threads write, for every provider. Timeline detail
        only changes how much of their work is shown. New turns use the saved style.
      </p>
    </SettingsSection>
  );
}

function ClaudeWorkflowSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["claudeWorkflowMode"]);
  return (
    <SettingsSection title="Claude workflows">
      <SettingsRow
        serverScoped
        settingKeys={["claudeWorkflowMode"]}
        {...searchableSetting("claude-workflow-mode")}
        description="Disabled prevents native workflows. On request starts them when you ask. Automatic lets Claude choose a workflow for complex work. Reasoning effort is set separately."
        resetAction={
          mixed || settings.claudeWorkflowMode !== DEFAULT_SERVER_SETTINGS.claudeWorkflowMode ? (
            <SettingResetButton
              label="Claude workflow mode"
              onClick={() =>
                update({ claudeWorkflowMode: DEFAULT_SERVER_SETTINGS.claudeWorkflowMode })
              }
            />
          ) : null
        }
        control={
          <Select
            value={mixed ? null : settings.claudeWorkflowMode}
            onValueChange={(value) => {
              if (ClaudeWorkflowMode.literals.includes(value as ClaudeWorkflowMode))
                update({ claudeWorkflowMode: value as ClaudeWorkflowMode });
            }}
          >
            <SelectTrigger size="sm" aria-label="Claude workflow mode">
              <SelectValue>
                {(value: ClaudeWorkflowMode | null) =>
                  value === null ? "Mixed" : WORKFLOW_MODES[value]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {ClaudeWorkflowMode.literals.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {WORKFLOW_MODES[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <p className="px-3 pb-3 text-sm text-muted-foreground sm:px-4">
        Applies to Claude Code providers with native workflow support. Workers already running keep
        their launch settings.
      </p>
    </SettingsSection>
  );
}

function InstructionEditor({
  previews,
}: {
  readonly previews: readonly AgentInstructionPreview[];
}) {
  const countId = useId();
  const project = previews[0]?.projectId !== null;
  const mixed = instructionValuesAreMixed(previews);
  const initial = mixed ? "" : (previews[0]?.editableInstructions ?? "");
  const [draft, setDraft] = useState(initial);
  const [hasDraft, setHasDraft] = useState(false);
  const edited = useRef(false);
  const canWrite = useScopedSettingsWriteAllowed();
  const update = useUpdateScopedSettings();
  const label = project ? "Project instructions" : "Global instructions";
  return (
    <SettingsSection title="Agent instructions">
      <SettingsRow
        serverScoped
        settingKeys={["agentInstructions"]}
        {...searchableSetting("agent-instructions")}
        title={label}
        description={
          project
            ? "Additional rules for this project. Global instructions are always included before these additions."
            : "Shared rules for Claude Code sessions in every project on each selected environment."
        }
        mixed={mixed}
        resetAction={
          mixed || initial !== "" ? (
            <SettingResetButton
              label="agent instructions"
              onClick={() => update({ agentInstructions: "" })}
            />
          ) : null
        }
      >
        <div className="mt-3 space-y-3 pb-3.5">
          <Textarea
            aria-label={label}
            rows={6}
            maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
            aria-describedby={countId}
            value={draft}
            disabled={!canWrite}
            placeholder={
              mixed
                ? "Mixed. Enter instructions to apply to all selected targets."
                : project
                  ? "Add project conventions, goals, and verification rules."
                  : "Add your working preferences and shared rules."
            }
            onChange={(event) => {
              edited.current = true;
              setHasDraft(true);
              setDraft(event.target.value);
            }}
            onBlur={() => {
              if (canWrite && edited.current && (mixed || draft.trim() !== initial))
                update({ agentInstructions: draft.trim() });
              edited.current = false;
            }}
          />
          <CharacterCount
            id={countId}
            className="-mt-2"
            value={draft}
            max={AGENT_INSTRUCTIONS_MAX_LENGTH}
          />
          <p className="text-sm text-muted-foreground">
            Studio rules and native project instructions remain included. These additions reach
            Claude Code leads and workflow workers. New sessions and resumed turns use the saved
            rules; running workers keep their launch context.
          </p>
          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">
              Effective instructions preview
            </summary>
            <div className="mt-3 space-y-4">
              {previews.map((preview) => (
                <div key={preview.key}>
                  {previews.length > 1 ? (
                    <h3 className="mb-1 text-sm font-medium">{preview.label}</h3>
                  ) : null}
                  <p className="mb-2 text-xs text-muted-foreground">
                    {preview.projectId === null
                      ? "Global instructions"
                      : "Global instructions + project additions"}
                  </p>
                  <pre
                    className="whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs"
                    aria-label={`Effective instructions for ${preview.label}`}
                  >
                    {previewAgentInstructions(preview, hasDraft ? draft : undefined) ||
                      "No additional agent instructions."}
                  </pre>
                </div>
              ))}
            </div>
          </details>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

export function AgentInstructionsSettings() {
  const { targets, connectedEnvironments } = useSettingsScope();
  const previews = agentInstructionPreviews(targets, connectedEnvironments);
  const editorKey = JSON.stringify(
    previews.map((preview) => [
      preview.key,
      preview.globalInstructions,
      preview.projectInstructions,
    ]),
  );
  return (
    <SettingsPageContainer>
      {previews.length > 0 ? (
        <InstructionEditor key={editorKey} previews={previews} />
      ) : (
        <p className="px-3 text-sm text-muted-foreground">
          Connect a selected environment to edit agent instructions.
        </p>
      )}
      <ResponseStyleSettings />
      <ClaudeWorkflowSettings />
    </SettingsPageContainer>
  );
}
