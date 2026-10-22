import { useRef, useState, type ReactNode } from "react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { ZapIcon } from "lucide-react";
import type { ModelLabel } from "../../studio/shellModel";
import { Tip } from "./shell/Tip";

/**
 * Same project setting as Settings → Default permissions, never a chat-local draft.
 * Shows the mode the coordinator runs in: a global default change leaves
 * existing chats as they were, so the setting alone can say Full access while
 * the coordinator still asks.
 */
export function CoordinatorAccessPicker({
  environmentId,
  projectId,
  coordinatorRuntimeMode = null,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  coordinatorRuntimeMode?: RuntimeMode | null;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const value =
    coordinatorRuntimeMode ??
    resolveProjectSettings(settings, projectId).settings.defaultRuntimeMode;
  const allowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const attemptedMode = useRef(value);
  async function change(mode: RuntimeMode) {
    if (!allowed || inFlight.current) return;
    inFlight.current = true;
    attemptedMode.current = mode;
    setPending(true);
    setError(null);
    try {
      const result = await save({
        environmentId,
        input: {
          patch: { projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: mode } } },
        },
      });
      if (result._tag === "Failure")
        setError("Could not apply permissions to every chat. Save again to retry.");
    } catch {
      setError("Could not apply permissions to every chat. Save again to retry.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <span className="sws-access-pick inline-flex flex-wrap items-center gap-1 text-xs">
      <Tip label="Applies to all chats in this project. Active provider turns finish before restarting. App approvals remain separate.">
        <select
          aria-label="Project permissions"
          className="sws-model-trigger sws-access-trigger max-w-40 bg-transparent"
          value={value}
          disabled={!allowed || pending}
          aria-busy={pending}
          onChange={(event) => void change(event.target.value as RuntimeMode)}
        >
          {runtimeModeOptions.map((mode) => (
            <option key={mode} value={mode}>
              {runtimeModeConfig[mode].label}
            </option>
          ))}
        </select>
      </Tip>
      {error ? (
        <button
          type="button"
          className="text-destructive-foreground"
          role="alert"
          onClick={() => void change(attemptedMode.current)}
          disabled={pending}
        >
          {error}
        </button>
      ) : null}
    </span>
  );
}

export function CoordinatorComposerControls({
  project,
  coordinatorRuntimeMode = null,
  fallback,
  children,
}: {
  project: { environmentId: EnvironmentId; id: ProjectId };
  /** The coordinator thread's own mode, once it exists. */
  coordinatorRuntimeMode?: RuntimeMode | null;
  fallback: {
    saved: ModelLabel;
    now: ModelLabel;
    /** Why the saved model has no room: `weekly limit reached, resets in 1d 15h`. */
    reason: string;
    /** `now` stopped on its own usage limit too, and nothing else runs the coordinator yet. */
    spent?: boolean;
    switching?: boolean;
    onSwitchBack?: (() => void) | null;
  } | null;
  children: ReactNode;
}) {
  return (
    <>
      {fallback ? (
        // The saved model stays saved; this line says what the coordinator runs on now.
        <p
          className="sws-model-fallback"
          role="status"
          data-model-fallback
          data-model-fallback-spent={fallback.spent ? "" : undefined}
        >
          <ZapIcon aria-hidden />
          <span className="sws-model-fallback-text">
            <strong>
              {fallback.spent
                ? `${fallback.now.provider} is out of usage too`
                : `Switched to ${fallback.now.provider}`}
            </strong>
            {": "}
            {fallback.saved.provider} {fallback.reason}.{" "}
            <span className="sws-model-fallback-note">
              The next turn after it has room goes back to {fallback.saved.provider} on its own.
            </span>
          </span>
          {fallback.onSwitchBack ? (
            <Tip
              label={`Run the next turn on ${fallback.saved.full} now. If it still has no room, that turn moves to ${fallback.spent ? "a provider with room" : fallback.now.full} again.`}
            >
              <button
                type="button"
                className="sws-model-fallback-back"
                disabled={fallback.switching}
                aria-busy={fallback.switching}
                onClick={fallback.onSwitchBack}
              >
                Switch back to {fallback.saved.provider}
              </button>
            </Tip>
          ) : null}
        </p>
      ) : null}
      {/* Model, effort and access share one left-aligned row, so resizing never moves them. */}
      <div className="sws-composer-controls" data-coordinator-composer-controls="">
        {children}
        <CoordinatorAccessPicker
          key={`${project.environmentId}:${project.id}`}
          environmentId={project.environmentId}
          projectId={project.id}
          coordinatorRuntimeMode={coordinatorRuntimeMode}
        />
      </div>
    </>
  );
}
