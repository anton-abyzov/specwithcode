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
import { Tip } from "./shell/Tip";

/** Same project setting as Settings → Default permissions, never a chat-local draft. */
export function CoordinatorAccessPicker({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const value = resolveProjectSettings(settings, projectId).settings.defaultRuntimeMode;
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
    <span className="inline-flex flex-wrap items-center gap-1 text-xs">
      <Tip label="Applies to all chats in this project. Active provider turns finish before restarting. App approvals remain separate.">
        <select
          aria-label="Project permissions"
          className="sws-model-trigger max-w-40 bg-transparent"
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
  fallback,
  children,
}: {
  project: { environmentId: EnvironmentId; id: ProjectId };
  fallback: { saved: { full: string }; now: { full: string } } | null;
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <CoordinatorAccessPicker
        key={`${project.environmentId}:${project.id}`}
        environmentId={project.environmentId}
        projectId={project.id}
      />
      {fallback ? (
        <Tip
          label={`Saved model: ${fallback.saved.full}. The coordinator goes back to it once its usage has room.`}
        >
          <span className="sws-model-fallback" role="status">
            On {fallback.now.full}
          </span>
        </Tip>
      ) : null}
    </>
  );
}
