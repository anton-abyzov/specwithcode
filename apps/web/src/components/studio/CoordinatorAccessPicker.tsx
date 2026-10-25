import { useRef, useState, type ReactNode } from "react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import {
  projectSettingsOverrideChangesPatch,
  resolveProjectSettings,
} from "@specweave-studio/shared/projectSettings";
import { useEnvironmentSettings, useProjectOverrideWriteMode } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { CircleAlertIcon, Undo2Icon } from "lucide-react";
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
  const writeMode = useProjectOverrideWriteMode(environmentId);
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
    if (!allowed || inFlight.current || writeMode === null) return;
    inFlight.current = true;
    attemptedMode.current = mode;
    setPending(true);
    setError(null);
    try {
      const result = await save({
        environmentId,
        input: {
          // Only this key: the project's other overrides stay as saved.
          patch: projectSettingsOverrideChangesPatch(
            settings,
            { [projectId]: { set: { defaultRuntimeMode: mode } } },
            writeMode === "per-key",
          ),
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
          disabled={!allowed || pending || writeMode === null}
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
          disabled={pending || writeMode === null}
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
    /** Why the saved model has no room, when known: `weekly limit reached, resets in 1d 15h`. */
    reason: string | null;
    /** `now` stopped on its own usage limit too, and nothing else runs the coordinator yet. */
    spent?: boolean;
    /** A turn runs on `now` at this moment. */
    live?: boolean;
    switching?: boolean;
    onSwitchBack?: (() => void) | null;
  } | null;
  children: ReactNode;
}) {
  return (
    <>
      {fallback && (fallback.onSwitchBack || fallback.spent) ? (
        <p
          className="sws-model-fallback"
          role="status"
          data-model-fallback
          data-model-fallback-live={fallback.live ? "" : undefined}
          data-model-fallback-spent={fallback.spent ? "" : undefined}
        >
          {fallback.spent ? <CircleAlertIcon aria-hidden /> : <Undo2Icon aria-hidden />}
          <span className="sws-model-fallback-text">
            {fallback.spent
              ? `${fallback.now.full} is out of usage too; nothing else can run the coordinator yet.`
              : `Your pick, ${fallback.saved.full}, has room again.`}
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
                {/* Name what differs: the harness, else the model, else the whole pick. */}
                Switch back to{" "}
                {fallback.saved.provider !== fallback.now.provider
                  ? fallback.saved.provider
                  : fallback.saved.model !== fallback.now.model
                    ? fallback.saved.model
                    : fallback.saved.full}
              </button>
            </Tip>
          ) : null}
        </p>
      ) : null}
      {/* Model, effort and access share one left-aligned row, so resizing never moves them. */}
      <div
        className="sws-composer-controls @container/composer-surface"
        data-coordinator-composer-controls=""
      >
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
