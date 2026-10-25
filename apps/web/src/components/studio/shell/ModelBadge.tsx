import type { OrchestrationV2ThreadShell } from "@specweave-studio/contracts";
import {
  fallbackModelState,
  ModelStateTag,
  ModelStateTip,
  type ModelState,
} from "../../chat/ModelStateTag";
import { isProviderDriverKind, ProviderDriverKind } from "@specweave-studio/contracts";
import { useMemo } from "react";
import { cn } from "~/lib/utils";
import {
  deriveProviderEntriesByEnvironment,
  type ProviderInstanceEntry,
} from "../../../providerInstances";
import { useServerConfigs } from "../../../state/entities";
import { modelLabel } from "../../../studio/shellModel";
import {
  ProviderInstanceIcon,
  resolveProviderInstanceAcpRegistryIconUrl,
} from "../../chat/ProviderInstanceIcon";
import { Tip } from "./Tip";
import { GitHubCopilotIcon } from "../../GitHubCopilotIcon";

const EMPTY_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();

/** Provider instances per host; an instance id only means something on its own host. */
export function useProviderEntriesByEnvironment(): ReadonlyMap<
  string,
  ReadonlyMap<string, ProviderInstanceEntry>
> {
  const configs = useServerConfigs();
  return useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...configs].map(
          ([environmentId, config]) => [environmentId, config.providers, config.settings] as const,
        ),
      ),
    [configs],
  );
}

export function useProviderEntries(
  environmentId: string,
): ReadonlyMap<string, ProviderInstanceEntry> {
  return useProviderEntriesByEnvironment().get(environmentId) ?? EMPTY_ENTRIES;
}

// A host that has not answered yet still gets the right mark for a built-in instance.
// Gemini CLI is an ACP Registry agent, not Antigravity.
const DRIVER_BY_HINT: ReadonlyArray<readonly [RegExp, string, string?]> = [
  [/claude/i, "claudeAgent"],
  [/codex|openai/i, "codex"],
  [/grok/i, "grok"],
  [/cursor/i, "cursor"],
  [/opencode/i, "opencode"],
  [/antigravity/i, "antigravity"],
  [/gemini/i, "acpRegistry", "gemini"],
  [/^pi\b/i, "pi"],
];

function guessDriver(instanceId: string): {
  driverKind: ProviderDriverKind;
  agentId?: string | undefined;
} {
  for (const [pattern, driver, agentId] of DRIVER_BY_HINT)
    if (pattern.test(instanceId)) return { driverKind: ProviderDriverKind.make(driver), agentId };
  return {
    driverKind: isProviderDriverKind(instanceId) ? instanceId : ProviderDriverKind.make("unknown"),
  };
}

/** The provider's mark alone, for rows too narrow to carry the words beside it. */
export function ModelBadgeMark(props: {
  entry: ProviderInstanceEntry | null;
  instanceId: string;
  provider: string;
}) {
  const guess = props.entry ? null : guessDriver(props.instanceId);
  const driverKind = props.entry?.driverKind ?? guess!.driverKind;
  const registryIcon = resolveProviderInstanceAcpRegistryIconUrl({
    driverKind,
    agentId: props.entry?.acpRegistryAgentId,
    iconUrl: props.entry?.acpRegistryIconUrl,
  });
  if (props.provider === "Copilot" && registryIcon === null) {
    // Keep the provider mark available before the host answers.
    return (
      <span className="sws-model-mark" aria-hidden>
        <GitHubCopilotIcon className="size-3.5" />
      </span>
    );
  }
  return (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={props.entry?.displayName ?? props.provider}
      accentColor={props.entry?.accentColor}
      acpRegistryAgentId={props.entry?.acpRegistryAgentId ?? guess?.agentId}
      acpRegistryIconUrl={props.entry?.acpRegistryIconUrl}
      className="sws-model-mark"
      iconClassName="size-3.5"
    />
  );
}

/**
 * Who runs a thread and on which model: the harness's mark and name, then the
 * model, as the composer picker says it ("Copilot · Claude Opus 5.5"). The
 * harness is named apart from the model's maker, so a Claude model reached
 * through Copilot never reads as a native Claude Code thread.
 */
export function ModelBadge(props: {
  entry: ProviderInstanceEntry | null;
  instanceId: string;
  model: string;
  /** `row` sits in a list line; `chip` is a bordered control-sized label. */
  variant?: "row" | "chip";
  className?: string;
  state?: ModelState | null;
  tooltip?: boolean;
  focusable?: boolean;
}) {
  const label = modelLabel(props.entry, props.instanceId, props.model);
  const badge = (
    <span
      tabIndex={props.focusable ? 0 : undefined}
      data-model-state={props.state?.kind}
      className={cn("sws-model", props.variant === "chip" && "sws-model-chip", props.className)}
    >
      <ModelBadgeMark entry={props.entry} instanceId={props.instanceId} provider={label.provider} />
      {label.full === label.model ? (
        // "Grok 5" already names its maker; saying Grok twice helps nobody.
        <span className="sws-model-name">{label.model}</span>
      ) : (
        <>
          <span className="sws-model-provider">{label.provider}</span>
          <span className="sws-model-sep" aria-hidden>
            ·
          </span>
          <span className="sws-model-name">{label.model}</span>
        </>
      )}
      {props.state ? <ModelStateTag state={props.state} /> : null}
    </span>
  );
  return props.tooltip ? (
    <Tip
      label={props.state ? <ModelStateTip current={label.full} state={props.state} /> : label.full}
    >
      {badge}
    </Tip>
  ) : (
    badge
  );
}

/** Shared shell identity: works in unopened rows without loading transcripts. */
export function ThreadModelBadge(props: {
  thread: Pick<OrchestrationV2ThreadShell, "modelSelection" | "modelIdentity">;
  entries: ReadonlyMap<string, ProviderInstanceEntry>;
  variant?: "row" | "chip";
  focusable?: boolean;
}) {
  const identity = props.thread.modelIdentity;
  const current = identity?.current ?? props.thread.modelSelection;
  const preferred = identity?.preferred;
  const label = preferred
    ? modelLabel(
        props.entries.get(preferred.instanceId) ?? null,
        preferred.instanceId,
        preferred.model,
      )
    : null;
  const state: ModelState | null = label
    ? identity?.kind === "fallback"
      ? fallbackModelState({
          pick: {
            ...label,
            instance:
              props.entries.get(preferred!.instanceId)?.displayName ?? preferred!.instanceId,
          },
          running: {
            ...modelLabel(
              props.entries.get(current.instanceId) ?? null,
              current.instanceId,
              current.model,
            ),
            instance: props.entries.get(current.instanceId)?.displayName ?? current.instanceId,
          },
          reason: "usage limit",
          launched: identity?.launched === true,
        })
      : { kind: "preferred", pick: label.full, pickModel: label.model }
    : null;
  return (
    <ModelBadge
      entry={props.entries.get(current.instanceId) ?? null}
      instanceId={current.instanceId}
      model={current.model}
      {...(props.variant ? { variant: props.variant } : {})}
      {...(props.focusable ? { focusable: true } : {})}
      state={state}
      tooltip
    />
  );
}
