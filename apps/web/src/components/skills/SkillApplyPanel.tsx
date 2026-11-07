import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";

export function SkillApplyPanel({
  userLevel,
  onScope,
  instanceIds,
  onAgents,
  agents,
  machineLabel,
  folder,
  busy,
  preview,
  result,
  onPreview,
  onApply,
}: {
  userLevel: boolean;
  onScope: (value: boolean) => void;
  instanceIds: readonly string[];
  onAgents: (value: string[]) => void;
  agents: readonly ProviderInstanceEntry[];
  machineLabel: string;
  folder: string;
  busy: boolean;
  preview: string | null;
  result: string | null;
  onPreview: () => void;
  onApply: () => void;
}) {
  return (
    <section className="space-y-4" aria-label="Apply published skill">
      <h3 className="font-medium">Apply this published version</h3>
      <p className="break-words text-sm text-muted-foreground">
        Machine: {machineLabel}
        <br />
        Project: {folder}
      </p>
      <fieldset disabled={busy} className="space-y-2 text-sm">
        <legend className="mb-2 font-medium">Where should it be available?</legend>
        <label className="flex gap-2">
          <input type="radio" checked={!userLevel} onChange={() => onScope(false)} />
          This project
        </label>
        <label className="flex gap-2">
          <input type="radio" checked={userLevel} onChange={() => onScope(true)} />
          My projects on this machine
        </label>
      </fieldset>
      <fieldset disabled={busy} className="space-y-2 text-sm">
        <legend className="mb-2 font-medium">Agents</legend>
        {agents.map((agent) => (
          <label className="flex gap-2" key={agent.instanceId}>
            <input
              type="checkbox"
              checked={instanceIds.includes(agent.instanceId)}
              onChange={(event) =>
                onAgents(
                  event.target.checked
                    ? [...instanceIds, agent.instanceId]
                    : instanceIds.filter((id) => id !== agent.instanceId),
                )
              }
            />
            {agent.displayName}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Project skills override a same-name user skill. Preview checks conflicts before any files
        change.
      </p>
      {preview ? (
        <div className="space-y-3 rounded-lg border p-3">
          <pre className="whitespace-pre-wrap break-all text-xs">{preview}</pre>
          <Button type="button" disabled={busy} onClick={onApply}>
            Apply version
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={busy || instanceIds.length === 0}
          onClick={onPreview}
        >
          Preview application
        </Button>
      )}
      {result ? (
        <p role="status" className="whitespace-pre-wrap text-sm">
          {result}
        </p>
      ) : null}
    </section>
  );
}
