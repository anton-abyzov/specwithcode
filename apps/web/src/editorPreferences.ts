import {
  AuthOrchestrationOperateScope,
  EDITORS,
  EditorId,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@specweave-studio/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { getLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useCallback, useMemo } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { readEnvironmentScope } from "./state/session";

/**
 * Only an editor the user picked is stored. The old `studio:last-editor` key also
 * held auto-persisted fallbacks (Cursor, first in the catalog), so it is not read.
 */
const PREFERRED_EDITOR_KEY = "studio:preferred-editor";

/** VS Code is the default; the remaining editors keep their catalog order. */
const DEFAULT_EDITOR_ORDER: ReadonlyArray<EditorId> = [
  "vscode",
  ...EDITORS.map((editor) => editor.id).filter((id) => id !== "vscode"),
];

/** The user's stored choice when it is installed, else VS Code, else the first installed editor. */
export function resolvePreferredEditor(
  stored: EditorId | null,
  availableEditors: ReadonlyArray<EditorId>,
): EditorId | null {
  if (stored && availableEditors.includes(stored)) return stored;
  return DEFAULT_EDITOR_ORDER.find((id) => availableEditors.includes(id)) ?? null;
}

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedError<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot open ${this.targetPath} because no environment is selected.`;
  }
}

export class PreferredEditorUnavailableError extends Schema.TaggedError<PreferredEditorUnavailableError>()(
  "PreferredEditorUnavailableError",
  {
    environmentId: EnvironmentId,
    targetPath: Schema.String,
    availableEditorIds: Schema.Array(EditorId),
  },
) {
  override get message(): string {
    return `No available editor can open ${this.targetPath} in environment ${this.environmentId}.`;
  }
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [storedEditor, setStoredEditor] = useLocalStorage(PREFERRED_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(
    () => resolvePreferredEditor(storedEditor, availableEditors),
    [storedEditor, availableEditors],
  );

  return [effectiveEditor, setStoredEditor] as const;
}

export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  type OpenInEditorError = AtomCommandFailure<Awaited<ReturnType<typeof openInEditor>>>;

  return useCallback(
    async (
      targetPath: string,
    ): Promise<
      AtomCommandResult<
        EditorId,
        | OpenInEditorError
        | PreferredEditorEnvironmentRequiredError
        | PreferredEditorUnavailableError
        | EnvironmentAuthorizationError
      >
    > => {
      if (environmentId === null) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorEnvironmentRequiredError({
              targetPath,
            }),
          ),
        );
      }
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthOrchestrationOperateScope,
              message: "This connection cannot open an editor on this environment.",
            }),
          ),
        );
      }
      const editor = resolvePreferredEditor(
        getLocalStorageItem(PREFERRED_EDITOR_KEY, EditorId),
        availableEditors,
      );
      if (!editor) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorUnavailableError({
              environmentId,
              targetPath,
              availableEditorIds: availableEditors,
            }),
          ),
        );
      }
      const result = await openInEditor({
        environmentId,
        input: {
          cwd: targetPath,
          editor,
        },
      });
      return mapAtomCommandResult(result, () => editor);
    },
    [availableEditors, environmentId, openInEditor],
  );
}
