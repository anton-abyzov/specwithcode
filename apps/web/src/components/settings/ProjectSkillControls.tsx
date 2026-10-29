/**
 * The Skills control center inside a skill's detail sheet: one place that
 * previews a change, applies it after the user confirms, and offers Undo.
 * The sections (version, per-agent switches, fleet push) read it from context.
 */
import {
  AuthEnvironmentMaintainScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ProjectSkillRow,
  type ProjectSkillsAction,
  type ProjectSkillsActionApplied,
  type ProjectSkillsActionPreview,
  type ProjectSkillsVersions,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { TriangleAlertIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  inverseSkillAction,
  skillActionErrorText,
  skillActionOverridden,
  skillActionLabel,
  skillAppliedText,
  skillPreviewLines,
  skillUpdateTarget,
  skillVersionControl,
  type SkillVersionState,
} from "./ProjectSkillActions.logic";

export interface SkillMemberProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

interface Proposal {
  readonly action: ProjectSkillsAction;
  readonly preview: ProjectSkillsActionPreview;
  readonly before: SkillVersionState;
}

export interface SkillControls {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly row: ProjectSkillRow;
  readonly memberProjects: ReadonlyArray<SkillMemberProject>;
  /** The machine-wide view: every switch is the user's own. */
  readonly userLevel: boolean;
  /** Settings files only (a skill switch kept in a settings file). */
  readonly canWrite: boolean;
  /** Changes that also run a CLI or app server. */
  readonly canOperate: boolean;
  readonly canPush: boolean;
  readonly canOpenStudio: boolean;
  readonly versions: {
    readonly data: ProjectSkillsVersions | null;
    readonly error: string | null;
    readonly isPending: boolean;
  };
  /** The key of the action being previewed or applied. */
  readonly pending: string | null;
  readonly proposal: Proposal | null;
  readonly error: string | null;
  readonly propose: (action: ProjectSkillsAction) => void;
  readonly apply: () => void;
  readonly cancel: () => void;
  /** Opens the push popover when the row menu asked for it. */
  readonly pushOpen: boolean;
  readonly setPushOpen: (open: boolean) => void;
}

const AGENT_RESCAN_MS = 4_000;

const SkillControlsContext = createContext<SkillControls | null>(null);

export function useSkillControls(): SkillControls | null {
  return useContext(SkillControlsContext);
}

/** A stable key for an action, so the control that asked for it can show it is busy. */
export function skillActionKey(action: ProjectSkillsAction): string {
  switch (action.kind) {
    case "toggle-skill":
      return `toggle-skill:${action.instanceId}`;
    case "toggle-plugin":
      return `toggle-plugin:${action.instanceId}:${action.pluginId}`;
    default:
      return action.kind;
  }
}

export function SkillControlsProvider({
  environmentId,
  projectId,
  row,
  memberProjects,
  userLevel = false,
  initialPushOpen = false,
  onChanged,
  onLatest,
  children,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  row: ProjectSkillRow;
  memberProjects: ReadonlyArray<SkillMemberProject>;
  /** A row of the machine-wide view: actions name the user level, and switches the user's files. */
  userLevel?: boolean;
  initialPushOpen?: boolean;
  /** Called after a change lands, to read the skills again. */
  onChanged: () => void;
  /** The newer version vskill reports for this skill, or null when it is current. */
  onLatest?: (skill: string, latest: string | null) => void;
  children: ReactNode;
}) {
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const canTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const canOperateStudio = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const run = useAtomCommand(projectWorkspace.skillAction, { reportFailure: false });
  const version = skillVersionControl(row);
  const versionsQuery = useEnvironmentQuery(
    version.skillId
      ? projectWorkspace.skillVersions({
          environmentId,
          input: { projectId, skill: row.name, ...(userLevel ? { userLevel: true } : {}) },
        })
      : null,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushOpen, setPushOpen] = useState(initialPushOpen);
  const refreshVersions = versionsQuery.refresh;
  const versionsData = versionsQuery.data;
  useEffect(() => {
    if (!onLatest || !versionsData) return;
    const newest = versionsData.versions[0]?.version ?? versionsData.outdated?.latest ?? null;
    onLatest(row.name, skillUpdateTarget(versionsData.installedVersion, newest));
  }, [onLatest, row.name, versionsData]);

  const call = useCallback(
    async (
      action: ProjectSkillsAction,
      preview: boolean,
      expected?: ProjectSkillsActionPreview["expected"],
    ) => {
      try {
        const result = await run({
          environmentId,
          input: {
            projectId,
            skill: row.name,
            ...(userLevel ? { userLevel: true } : {}),
            preview,
            action,
            ...(expected ? { expected } : {}),
          },
        });
        if (result._tag === "Success") return { ok: true as const, value: result.value };
        return {
          ok: false as const,
          message: skillActionErrorText(squashAtomCommandFailure(result)),
        };
      } catch {
        return { ok: false as const, message: "The machine did not confirm the change." };
      }
    },
    [environmentId, projectId, row.name, run, userLevel],
  );

  // The delayed rescans, cleared when the sheet closes so none fires after it.
  const rescans = useRef(new Set<number>());
  useEffect(() => {
    const pending = rescans.current;
    return () => {
      for (const id of pending) window.clearTimeout(id);
      pending.clear();
    };
  }, []);
  const landed = useCallback(
    (action: ProjectSkillsAction) => {
      onChanged();
      // Each agent rescans the folder on its own after a write; read once more when it has.
      const id = window.setTimeout(() => {
        rescans.current.delete(id);
        onChanged();
      }, AGENT_RESCAN_MS);
      rescans.current.add(id);
      if (action.kind !== "toggle-skill" && action.kind !== "toggle-plugin") refreshVersions();
    },
    [onChanged, refreshVersions],
  );

  /** Undo runs the inverse the same way: a fresh preview for its file state, then the write. */
  const undo = useCallback(
    async (action: ProjectSkillsAction) => {
      const previewed = await call(action, true);
      const applied =
        previewed.ok && "preview" in previewed.value
          ? await call(action, false, previewed.value.preview.expected)
          : previewed;
      if (applied.ok && "applied" in applied.value) {
        toastManager.add({
          type: skillActionOverridden(action, applied.value) ? "warning" : "success",
          title: `Undone: ${skillActionLabel(action, row.name)}`,
          description: skillAppliedText(applied.value).description,
        });
      } else {
        toastManager.add({
          type: "error",
          title: "Could not undo",
          description: applied.ok ? "The machine did not confirm the change." : applied.message,
        });
      }
      landed(action);
    },
    [call, landed, row.name],
  );

  const announce = useCallback(
    (applied: ProjectSkillsActionApplied, proposalNow: Proposal) => {
      const text = skillAppliedText(applied);
      const inverse = inverseSkillAction(proposalNow.action, proposalNow.before);
      const id = toastManager.add({
        // The write landed, but the agent kept the other state: still undoable, not a success.
        type: skillActionOverridden(proposalNow.action, applied) ? "warning" : "success",
        title: text.title,
        description: text.description,
        ...(inverse
          ? {
              actionProps: {
                children: "Undo",
                onClick: () => {
                  toastManager.close(id);
                  void undo(inverse);
                },
              },
            }
          : {}),
      });
    },
    [undo],
  );

  const propose = useCallback(
    (action: ProjectSkillsAction) => {
      if (pending !== null) return;
      setError(null);
      setProposal(null);
      setPending(skillActionKey(action));
      void call(action, true).then((result) => {
        setPending(null);
        if (!result.ok) return setError(result.message);
        if (!("preview" in result.value))
          return setError("The machine changed it without a preview. Rescan to check.");
        setProposal({
          action,
          preview: result.value.preview,
          before: {
            installedVersion: version.installedVersion,
            pinnedVersion: version.pinnedVersion,
          },
        });
      });
    },
    [call, pending, version.installedVersion, version.pinnedVersion],
  );

  const apply = useCallback(() => {
    if (proposal === null || pending !== null) return;
    const current = proposal;
    setPending(skillActionKey(current.action));
    setError(null);
    void call(current.action, false, current.preview.expected).then((result) => {
      setPending(null);
      if (!result.ok) return setError(result.message);
      setProposal(null);
      if ("applied" in result.value) announce(result.value, current);
      landed(current.action);
    });
  }, [announce, call, landed, pending, proposal]);

  const value = useMemo<SkillControls>(
    () => ({
      environmentId,
      projectId,
      row,
      memberProjects,
      userLevel,
      canWrite,
      canOperate: canWrite && canTerminal,
      canPush: canMaintain,
      canOpenStudio: canOperateStudio,
      versions: {
        data: versionsQuery.data,
        error: versionsQuery.error,
        isPending: versionsQuery.isPending,
      },
      pending,
      proposal,
      error,
      propose,
      apply,
      cancel: () => {
        setProposal(null);
        setError(null);
      },
      pushOpen,
      setPushOpen,
    }),
    [
      apply,
      canMaintain,
      canOperateStudio,
      canTerminal,
      canWrite,
      environmentId,
      error,
      memberProjects,
      pending,
      projectId,
      proposal,
      propose,
      pushOpen,
      row,
      userLevel,
      versionsQuery.data,
      versionsQuery.error,
      versionsQuery.isPending,
    ],
  );
  return <SkillControlsContext.Provider value={value}>{children}</SkillControlsContext.Provider>;
}

/** The one-line confirm card: what runs or changes, when it takes effect, Apply or Cancel. */
export function SkillActionPreviewCard() {
  const controls = useSkillControls();
  if (!controls || (!controls.proposal && !controls.error)) return null;
  const { proposal, error, pending } = controls;
  const lines = proposal ? skillPreviewLines(proposal.preview) : null;
  return (
    <div
      className="space-y-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs"
      data-testid="skill-action-preview"
      role={error ? "alert" : "status"}
    >
      {lines ? (
        <>
          <p className="font-medium text-foreground">{lines.summary}</p>
          {lines.detail ? (
            <p className="break-all font-mono text-2xs text-muted-foreground">{lines.detail}</p>
          ) : null}
          <p className="text-muted-foreground">{lines.when}</p>
          {lines.warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-1 text-warning-foreground">
              <TriangleAlertIcon aria-hidden className="mt-px size-3 shrink-0" />
              {warning}
            </p>
          ))}
        </>
      ) : null}
      {error ? <p className="text-destructive-foreground">{error}</p> : null}
      <div className="flex justify-end gap-1.5">
        <Button size="xs" variant="ghost" type="button" onClick={controls.cancel}>
          {proposal ? "Cancel" : "Dismiss"}
        </Button>
        {proposal ? (
          <Button
            size="xs"
            type="button"
            disabled={pending !== null}
            onClick={controls.apply}
            data-testid="skill-action-apply"
          >
            {pending !== null ? <Spinner className="size-3" /> : null}
            Apply
          </Button>
        ) : null}
      </div>
    </div>
  );
}
