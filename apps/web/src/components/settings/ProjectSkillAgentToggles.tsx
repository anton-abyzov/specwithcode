/** One agent's switches in the sheet's "Loaded by" list: the skill, and the plugin it ships in. */
import type { ProjectSkillPresence } from "@specweave-studio/contracts";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import {
  LIVENESS_LABELS,
  pluginSwitchFor,
  skillPluginOf,
  skillSwitchFor,
  skillSwitchLiveness,
} from "./ProjectSkillActions.logic";
import { skillActionKey, useSkillControls } from "./ProjectSkillControls";
import { SkillControlReason } from "./ProjectSkillReason";

export function ProjectSkillAgentToggle({ presence }: { presence: ProjectSkillPresence }) {
  const controls = useSkillControls();
  if (!controls) return null;
  const toggle = skillSwitchFor(presence, { userLevel: controls.userLevel });
  const liveness = skillSwitchLiveness(presence);
  // A switch kept in a settings file needs only file access; Codex's runs its app server.
  const allowed = toggle.available
    ? presence.driver === "claudeAgent" || presence.switchFile !== undefined
      ? controls.canWrite
      : controls.canOperate
    : false;
  const busy = toggle.available && controls.pending === skillActionKey(toggle.action);
  const label = `${presence.enabled ? "Turn off" : "Turn on"} ${controls.row.name} for ${presence.label}`;
  const reason = !toggle.available
    ? toggle.reason
    : allowed
      ? null
      : "Needs permission to change this agent's settings here.";
  const control = (
    <Switch
      size="sm"
      checked={presence.enabled}
      disabled={!allowed || controls.pending !== null}
      aria-label={label}
      data-testid="skill-agent-switch"
      data-driver={presence.driver}
      onCheckedChange={() => {
        if (toggle.available) controls.propose(toggle.action);
      }}
    />
  );
  return (
    <span
      className="ms-auto flex items-center gap-1.5"
      title={presence.switchFile ? `Switch kept in ${presence.switchFile}` : undefined}
    >
      {liveness ? (
        <span className="text-2xs text-muted-foreground" data-testid="skill-liveness">
          {LIVENESS_LABELS[liveness]}
        </span>
      ) : null}
      {busy ? <Spinner className="size-3" /> : null}
      <SkillControlReason reason={reason}>{control}</SkillControlReason>
    </span>
  );
}

/** Whole-plugin control beside the agent's path. */
export function ProjectSkillPluginToggle({ presence }: { presence: ProjectSkillPresence }) {
  const controls = useSkillControls();
  const plugin = skillPluginOf(presence);
  if (!controls || !plugin) return null;
  // Claude plugin discovery retains disabled copies; other agents can disable
  // individual skills, so their skill state does not identify the plugin state.
  const enablePlugin =
    presence.driver === "claudeAgent" && presence.scope === "plugin" && !presence.enabled;
  const action = pluginSwitchFor(presence, enablePlugin);
  if (!action) return null;
  return (
    <SkillControlReason
      reason={controls.canOperate ? null : "Needs permission to run this agent's CLI here."}
    >
      <Button
        size="micro"
        variant="ghost-muted"
        type="button"
        disabled={!controls.canOperate || controls.pending !== null}
        onClick={() => controls.propose(action)}
      >
        {enablePlugin ? "Turn on" : "Turn off"} plugin {plugin.name}
      </Button>
    </SkillControlReason>
  );
}
