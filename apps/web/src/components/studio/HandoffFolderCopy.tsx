import { useEffect, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { AtomCommandResult } from "@specweave-studio/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type FolderCopyChoice,
  type FolderCopyFileClass,
  type FolderCopyMode,
  type FolderCopyOffer,
  type FolderCopySourceSummary,
  type FolderCopyStatus,
  type FolderCopyUndoResult,
  type MachineHandoffBundle,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import { linkCopyAsWorkers, projectLink, type CopyLinkOutcome } from "../../studio/projectLink";
import {
  cloneableRows,
  copySettled,
  copyDestinationKey,
  copiedProjectFolder,
  savedCopyRoot,
  suggestedCopyFolder,
  DEFAULT_COPY_SELECTION,
  formatBytes,
  type HandoffFolderMethod,
} from "../../studio/folderCopy";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { MachineReadinessChecklist } from "../settings/MachineReadinessChecklist";
import { HandoffSecretsStep } from "./HandoffSecretsStep";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import {
  CopyClassPicker,
  CopyPlanPreview,
  CopyProgress,
  CopyUndoPreview,
} from "./HandoffCopyPreview";
import { ProjectLinkDialog } from "./ProjectLinkDialog";
import { HandoffCopyActions } from "./HandoffCopyActions";
import { HandoffCopyScope, CopyScopeMapping, useCopyScope } from "./HandoffCopyScope";

export interface CopyMachine {
  readonly id: EnvironmentId;
  readonly label: string;
  readonly unavailable: string | null;
}

type Stage =
  | "setup"
  | "scanning"
  | "select"
  | "planning"
  | "preview"
  | "copying"
  | "moving"
  | "done"
  | "undone"
  | "failed";

interface PendingCopy {
  readonly operationId: string;
  readonly environmentId: string;
  readonly mode: FolderCopyMode;
  readonly targetFolder: string;
  readonly projectId: string | null;
  readonly copyRoot?: string;
  readonly projectRelativePath?: string;
}

const POLL_MS = 1000;

export const folderCopyStorageKey = (environmentId: string, projectId: string) =>
  `specwithcode:folder-copy:${environmentId}:${projectId}`;

function readPending(key: string): PendingCopy | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as PendingCopy | null;
    return value && typeof value.operationId === "string" && typeof value.environmentId === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

const isNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { _tag?: unknown })._tag === "FolderCopyError" &&
  (cause as { code?: unknown }).code === "not_found";

const messageOf = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The copy could not continue.";

/** A destination refusal happened before this attempt could publish a source fence. */
class DestinationContextPreviewError extends Error {
  constructor(cause: unknown) {
    super(messageOf(cause), { cause });
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("closed", "AbortError"));
    });
  });

/**
 * Copies the project folder to another machine: the destination pulls the files from
 * this machine, previews what changes, and applies only after approval.
 */
export function HandoffFolderCopy({
  project,
  coordinatorId,
  sourceLabel,
  method,
  machines,
  savedFolder,
  savedProject,
  preferredMachine = null,
  canMove,
  onBusyChange,
  onOpenProject,
}: {
  readonly project: EnvironmentProject;
  readonly coordinatorId: ThreadId | null;
  readonly sourceLabel: string;
  readonly method: Exclude<HandoffFolderMethod, "folder">;
  readonly machines: ReadonlyArray<CopyMachine>;
  readonly savedFolder: (environmentId: EnvironmentId) => string | null;
  readonly savedProject?: (
    environmentId: EnvironmentId,
    folder: string,
  ) => EnvironmentProject | null;
  /** The remembered or last-used machine, preselected when it can take the copy. */
  readonly preferredMachine?: EnvironmentId | null;
  readonly canMove: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onOpenProject: (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly folder: string;
  }) => void;
}) {
  const scope = useCopyScope(project);
  const capabilities = useAtomCommand(machineHandoff.copyCapabilities, { reportFailure: false });
  const offerCopy = useAtomCommand(machineHandoff.copyOffer, { reportFailure: false });
  const sourceStatus = useAtomCommand(machineHandoff.copySourceStatus, { reportFailure: false });
  const sourceCancel = useAtomCommand(machineHandoff.copySourceCancel, { reportFailure: false });
  const release = useAtomCommand(machineHandoff.copyRelease, { reportFailure: false });
  const start = useAtomCommand(machineHandoff.copyStart, { reportFailure: false });
  const status = useAtomCommand(machineHandoff.copyStatus, { reportFailure: false });
  const decide = useAtomCommand(machineHandoff.copyDecide, { reportFailure: false });
  const approve = useAtomCommand(machineHandoff.copyApprove, { reportFailure: false });
  const retry = useAtomCommand(machineHandoff.copyRetry, { reportFailure: false });
  const cancel = useAtomCommand(machineHandoff.copyCancel, { reportFailure: false });
  const undo = useAtomCommand(machineHandoff.copyUndo, { reportFailure: false });
  const sendSecrets = useAtomCommand(machineHandoff.copySecrets, { reportFailure: false });
  const prepare = useAtomCommand(machineHandoff.prepare, { reportFailure: false });
  const receive = useAtomCommand(machineHandoff.receive, { reportFailure: false });
  const linkPreview = useAtomCommand(projectLink.preview, { reportFailure: false });
  const linkPrepare = useAtomCommand(projectLink.prepare, { reportFailure: false });
  const linkAccept = useAtomCommand(projectLink.accept, { reportFailure: false });
  const linkCommit = useAtomCommand(projectLink.commit, { reportFailure: false });

  const storageKey = folderCopyStorageKey(project.environmentId, project.id);
  const firstMachine =
    machines.find((machine) => machine.id === preferredMachine && !machine.unavailable)?.id ??
    machines.find((machine) => !machine.unavailable)?.id ??
    null;
  const [machine, setMachine] = useState<EnvironmentId | null>(firstMachine);
  const [folderDraft, setFolderDraft] = useState<{
    machine: EnvironmentId;
    value: string;
    copyRoot?: string;
  } | null>(null);
  const access = useFilesystemReadAccess(machine);
  const home = useEnvironmentQuery(
    machine && access.canReadFiles
      ? filesystemEnvironment.browse({ environmentId: machine, input: { partialPath: "~/" } })
      : null,
  );
  // The query belongs to the selected machine. A late home response never replaces a typed path.
  const folder = machine
    ? folderDraft?.machine === machine &&
      (!folderDraft.copyRoot || folderDraft.copyRoot === scope.selected.copyRoot)
      ? folderDraft.value
      : (savedCopyRoot(savedFolder(machine), scope.selected.projectRelativePath) ??
        suggestedCopyFolder(scope.selected.copyRoot, home.data?.parentPath))
    : "";
  const setFolder = (value: string, environmentId = machine, copyRoot?: string) => {
    if (environmentId)
      setFolderDraft({ machine: environmentId, value, ...(copyRoot ? { copyRoot } : {}) });
  };
  const [mode, setMode] = useState<FolderCopyMode>("copy-only");
  const [stage, setStage] = useState<Stage>("setup");
  const [offer, setOffer] = useState<FolderCopyOffer | null>(null);
  const [summary, setSummary] = useState<FolderCopySourceSummary | null>(null);
  const [selection, setSelection] =
    useState<ReadonlyArray<FolderCopyFileClass>>(DEFAULT_COPY_SELECTION);
  const [copy, setCopy] = useState<FolderCopyStatus | null>(null);
  const [secretPaths, setSecretPaths] = useState<ReadonlyArray<string>>([]);
  const [secretsConfirmed, setSecretsConfirmed] = useState(false);
  const [pending, setPending] = useState<PendingCopy | null>(null);
  const [undoPreview, setUndoPreview] = useState<FolderCopyUndoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transferNotice, setTransferNotice] = useState<string | null>(null);
  const [contextTransferred, setContextTransferred] = useState(false);
  const [copyAgain, setCopyAgain] = useState(false);
  const [transferRecovery, setTransferRecovery] = useState(false);
  const [working, setWorking] = useState(false);
  const [link, setLink] = useState<CopyLinkOutcome | { readonly status: "linking" } | null>(null);
  const [linkDialog, setLinkDialog] = useState(false);
  const running = useRef(false);
  const contextPublished = useRef(false);
  const copiedProjects = useRef(new Map<string, ProjectId>());
  // Applying files can register or update a project while an async command is in flight.
  const latestSavedProject = useRef(savedProject);
  latestSavedProject.current = savedProject;
  const knownProject = (environmentId: EnvironmentId, targetFolder: string) => {
    const known = latestSavedProject.current?.(environmentId, targetFolder);
    return known &&
      copyDestinationKey(known.environmentId, known.workspaceRoot) ===
        copyDestinationKey(environmentId, targetFolder)
      ? known
      : null;
  };
  const abort = useRef(new AbortController());
  useEffect(() => {
    const controller = abort.current;
    return () => controller.abort();
  }, []);

  const busy =
    working ||
    stage === "scanning" ||
    stage === "planning" ||
    stage === "copying" ||
    stage === "moving";
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  const target = machines.find((entry) => entry.id === machine) ?? null;
  const targetLabel = target?.label ?? "the other machine";

  const remember = (value: PendingCopy | null) => {
    setPending(value);
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value));
      else localStorage.removeItem(storageKey);
    } catch {
      /* The copy still runs; only resuming after a reload needs the pointer. */
    }
  };

  const run = async (step: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setWorking(true);
    setError(null);
    try {
      await step();
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        setError(messageOf(cause));
    } finally {
      running.current = false;
      setWorking(false);
    }
  };

  const pollCopy = async (environmentId: EnvironmentId, operationId: string) => {
    for (;;) {
      const next = unwrap(
        await status({
          environmentId,
          input: { operationId: operationId },
        }),
      );
      setCopy(next);
      if (copySettled(next)) return next;
      await sleep(POLL_MS, abort.current.signal);
    }
  };

  const show = (next: FolderCopyStatus) => {
    if (next.state === "previewed") setStage("preview");
    else if (next.state === "failed") setStage("failed");
    else if (next.state === "undone" || next.state === "cancelled") setStage("undone");
    else if (next.state === "applied" && next.committed && next.projectId) setStage("done");
    else setStage("copying");
  };

  // Resume a copy this browser started before a reload or a closed dialog.
  const resume = (saved: PendingCopy) => {
    setPending(saved);
    setMachine(saved.environmentId as EnvironmentId);
    setFolder(saved.targetFolder, saved.environmentId as EnvironmentId);
    setMode(saved.mode);
    void run(async () => {
      const environmentId = saved.environmentId as EnvironmentId;
      let next: FolderCopyStatus;
      try {
        next = await pollCopy(environmentId, saved.operationId);
      } catch (cause) {
        // An unreachable destination keeps the pointer; only a copy it never started is dropped.
        if (!isNotFound(cause)) throw cause;
        const operationId = saved.operationId;
        const reason = "The copy was not started.";
        await sourceCancel({
          environmentId: project.environmentId,
          input: { operationId, reason },
        });
        if (saved.mode === "copy-and-move")
          await release({
            environmentId: project.environmentId,
            input: { projectId: project.id, operationId, reason },
          });
        remember(null);
        setStage("setup");
        return;
      }
      show(next);
      if (saved.mode === "copy-and-move" && next.state === "applied" && next.projectId) {
        // A prior request may already have fenced the source. Keep its recovery pointer.
        setTransferRecovery(true);
        setTransferNotice("The files are copied. Transfer coordinator context when you are ready.");
      }
    });
  };
  useEffect(() => {
    const saved = readPending(storageKey);
    if (saved) resume(saved);
  }, [storageKey]);

  // "Copy files only" ends with the copy linked as a member that runs workers; the coordinator stays here.
  const linkCopy = async (environmentId: EnvironmentId, projectId: ProjectId) => {
    setLink({ status: "linking" });
    try {
      setLink(
        await linkCopyAsWorkers(
          {
            preview: linkPreview,
            prepare: linkPrepare,
            accept: linkAccept,
            commit: linkCommit,
          },
          {
            kept: { environmentId: project.environmentId, projectId: project.id },
            joining: { environmentId, projectId },
            keptLabel: sourceLabel,
            joiningLabel: targetLabel,
            newOperationId: randomUUID,
          },
        ),
      );
    } catch (cause) {
      setLink({ status: "review", reason: messageOf(cause) });
    }
  };
  const linkTarget =
    stage === "done" && mode === "copy-only" && copy?.projectId ? copy.projectId : null;
  useEffect(() => {
    if (linkTarget && machine && link === null) void linkCopy(machine, linkTarget);
  }, [linkTarget, machine]);

  const destinationPlan = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    targetFolder: string,
  ) => {
    const known = knownProject(environmentId, targetFolder);
    if (known && known.id !== projectId)
      throw new DestinationContextPreviewError(
        new Error(
          "The destination registration changed. Check this copied folder before transferring context.",
        ),
      );
    return {
      environmentId,
      projectId,
      executionMode: "project-folder" as const,
      transport: "folder-copy" as const,
      coordinatorThreadId:
        known?.workspaceSettings?.coordinatorThreadId ??
        ThreadId.make(`project-coordinator:${projectId}`),
      ...(known?.workspaceSettings?.logicalProject
        ? { logicalProjectId: known.workspaceSettings.logicalProject.id }
        : {}),
      joinExistingProject: true,
    };
  };

  /** Fences the source coordinator for a move; repeated calls return the same published bundle. */
  const fence = async (
    operationId: string,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    targetFolder: string,
  ) => {
    if (!coordinatorId) throw new Error("Open this project’s coordinator before moving it.");
    const base = {
      projectId: project.id,
      sourceThreadId: coordinatorId,
      operationId: operationId,
      destination: destinationPlan(environmentId, projectId, targetFolder),
    };
    const prepared = unwrap(
      await prepare({ environmentId: project.environmentId, input: { ...base, publish: false } }),
    );
    if (prepared.publication === "published") {
      contextPublished.current = true;
      return prepared.bundle;
    }
    // Check the actual registration, logical identity, coordinator and idle state
    // before fencing the source. Conversation contents stay on the source here.
    const bundle = prepared.bundle;
    try {
      const checked = unwrap(
        await receive({
          environmentId,
          input: {
            projectId,
            operationId: bundle.manifest.operationId,
            mode: "preview",
            manifest: bundle.manifest,
            sourceEnvironmentId: bundle.sourceEnvironmentId,
            sourceProjectId: bundle.sourceProjectId,
            sourceThreadId: bundle.sourceThreadId,
            digest: bundle.digest,
            ...(bundle.logicalProject ? { logicalProject: bundle.logicalProject } : {}),
            ...(bundle.coordinatorBinding ? { coordinatorBinding: bundle.coordinatorBinding } : {}),
            ...(bundle.destination ? { destination: bundle.destination } : {}),
          },
        }),
      );
      if (checked.executionMode !== "project-folder" || checked.projectId !== projectId)
        throw new Error(
          "Update or check the destination before transferring context into this copied folder.",
        );
    } catch (cause) {
      throw new DestinationContextPreviewError(cause);
    }
    const published = unwrap(
      await prepare({
        environmentId: project.environmentId,
        input: {
          ...base,
          destination: bundle.destination ?? base.destination,
          publish: true,
          expectedDigest: bundle.digest,
        },
      }),
    ).bundle;
    contextPublished.current = true;
    return published;
  };

  /** After the files are applied, the coordinator continues on the destination. */
  const moveCoordinator = async (
    operationId: string,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    applied: FolderCopyStatus | null = copy,
  ) => {
    if (applied && (applied.unstable.length > 0 || applied.checks.some((check) => !check.ok))) {
      setCopyAgain(true);
      setTransferNotice(
        "The files are copied with changes or checks still unresolved. Copy again before transferring coordinator context.",
      );
      setStage("done");
      return;
    }
    setStage("moving");
    setTransferRecovery(true);
    try {
      await continueThere(
        operationId,
        environmentId,
        projectId,
        applied?.projectFolder ??
          copiedProjectFolder(
            applied?.targetFolder ?? folder,
            applied?.projectRelativePath ?? pending?.projectRelativePath,
          ),
      );
    } catch (cause) {
      if (cause instanceof DestinationContextPreviewError) {
        // No publish was attempted here. Starting fresh still asks the source to
        // release the operation, so a fence from an older session cannot be lost.
        setTransferRecovery(false);
        setTransferNotice(
          `The files are copied. ${targetLabel} is not ready for coordinator context: ${cause.message} Retry this step, or start a new copy to update the destination.`,
        );
        setStage("done");
        return;
      }
      if (
        typeof cause === "object" &&
        cause !== null &&
        (cause as { code?: unknown }).code === "busy" &&
        !contextPublished.current
      ) {
        setTransferRecovery(false);
        setTransferNotice(
          `The files are copied. Work is still running on ${sourceLabel}, so coordinator context has not transferred. Retry this step when that work is idle.`,
        );
        setStage("done");
        return;
      }
      const changed =
        typeof cause === "object" &&
        cause !== null &&
        (cause as { code?: unknown }).code === "source_changed" &&
        !contextPublished.current;
      setCopyAgain(changed);
      if (changed) setTransferRecovery(false);
      setTransferNotice(
        changed
          ? "The files are copied, but the source has changed. Copy again before transferring coordinator context."
          : `The files are copied. Coordinator context transfer is pending: ${messageOf(cause)}`,
      );
      setStage("done");
      return;
    }
    setTransferRecovery(false);
    setContextTransferred(true);
    setTransferNotice(null);
    // Undo is for copies only; a finished move has nothing left to resume.
    remember(null);
    setStage("done");
  };

  const continueThere = async (
    operationId: string,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    targetFolder: string,
  ) => {
    const bundle: MachineHandoffBundle = await fence(
      operationId,
      environmentId,
      projectId,
      targetFolder,
    );
    const started = unwrap(
      await receive({
        environmentId,
        input: { projectId, operationId: bundle.manifest.operationId, mode: "start", bundle },
      }),
    );
    if (started.phase !== "started" || !started.coordinatorThreadId)
      throw new Error("The files are in place, but the coordinator has not started. Retry.");
    if (bundle.logicalProject) {
      unwrap(
        await prepare({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            sourceThreadId: coordinatorId!,
            operationId: bundle.manifest.operationId,
            publish: true,
            expectedDigest: bundle.digest,
            destination:
              bundle.destination ?? destinationPlan(environmentId, projectId, targetFolder),
            acknowledgment: {
              operationId: bundle.manifest.operationId,
              environmentId,
              projectId: started.projectId,
              coordinatorThreadId: started.coordinatorThreadId,
              digest: bundle.digest,
            },
          },
        }),
      );
    }
  };

  const measure = () =>
    run(async () => {
      if (!machine || target?.unavailable || scope.loading) return;
      if (!folder.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(folder))
        throw new Error("Enter the full absolute path of the folder on the destination machine.");
      if (scope.selected.projectRelativePath !== ".") {
        try {
          const supported = unwrap(await capabilities({ environmentId: machine, input: {} }));
          if (supported.scopeVersion !== 1) throw new Error("unsupported");
        } catch {
          throw new Error(
            `Update or reconnect ${targetLabel} before copying an umbrella. You can still select this project folder only.`,
          );
        }
      }
      const projectFolder = copiedProjectFolder(folder, scope.selected.projectRelativePath);
      const operationId = randomUUID();
      const destinationProjectId =
        mode === "copy-and-move"
          ? (knownProject(machine, projectFolder)?.id ??
            copiedProjects.current.get(copyDestinationKey(machine, projectFolder)) ??
            randomUUID())
          : null;
      remember({
        operationId,
        environmentId: machine,
        mode,
        targetFolder: folder,
        copyRoot: scope.selected.copyRoot,
        projectRelativePath: scope.selected.projectRelativePath,
        projectId: destinationProjectId,
      });
      setStage("scanning");
      try {
        const offered = unwrap(
          await offerCopy({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              operationId: operationId,
              mode,
              destinationEnvironmentId: machine,
              ...(scope.selected.projectRelativePath !== "."
                ? { copyRoot: scope.selected.copyRoot }
                : {}),
            },
          }),
        );
        setOffer(offered);
        let scanned = offered.status;
        while (scanned.state === "scanning") {
          await sleep(POLL_MS, abort.current.signal);
          scanned = unwrap(
            await sourceStatus({
              environmentId: project.environmentId,
              input: { operationId: operationId },
            }),
          );
        }
        if (!scanned.summary) throw new Error(scanned.error ?? "The folder could not be read.");
        setSummary(scanned.summary);
        setStage("select");
      } catch (cause) {
        remember(null);
        setStage("setup");
        throw cause;
      }
    });

  const plan = () =>
    run(async () => {
      if (!offer || !machine || !pending) return;
      setStage("planning");
      try {
        unwrap(
          await start({
            environmentId: machine,
            input: {
              operationId: offer.operationId,
              sourceEnvironmentId: offer.sourceEnvironmentId,
              sourceProjectId: offer.sourceProjectId,
              sourceUrl: offer.sourceUrl,
              sourceMachine: offer.sourceMachine,
              token: offer.token,
              title: offer.title,
              mode: offer.mode,
              targetFolder: pending.targetFolder,
              ...(offer.copyRoot ? { copyRoot: offer.copyRoot } : {}),
              ...(offer.projectRelativePath
                ? { projectRelativePath: offer.projectRelativePath }
                : {}),
              selection,
              ...(pending.projectId ? { projectId: ProjectId.make(pending.projectId) } : {}),
            },
          }),
        );
        let next = await pollCopy(machine, offer.operationId);
        if (method === "clone" && next.state === "previewed") {
          const rows = cloneableRows(next.rows);
          if (rows.length > 0) {
            unwrap(
              await decide({
                environmentId: machine,
                input: { operationId: offer.operationId, clone: rows },
              }),
            );
            next = await pollCopy(machine, offer.operationId);
          }
        }
        show(next);
      } catch (cause) {
        setStage("select");
        throw cause;
      }
    });

  const change = (input: {
    readonly decisions?: Readonly<Record<string, FolderCopyChoice>>;
    readonly clone?: ReadonlyArray<string>;
  }) =>
    run(async () => {
      if (!machine || !pending) return;
      setStage("planning");
      unwrap(
        await decide({
          environmentId: machine,
          input: { operationId: pending.operationId, ...input },
        }),
      );
      show(await pollCopy(machine, pending.operationId));
    });

  const apply = () =>
    run(async () => {
      if (!machine || !pending) return;
      const operationId = pending.operationId;
      if (secretPaths.length > 0 && secretsConfirmed)
        // The source hands out only the ticked secret files, to this destination only.
        unwrap(
          await sendSecrets({
            environmentId: project.environmentId,
            input: {
              operationId,
              paths: secretPaths,
              destinationLabel: targetLabel,
            },
          }),
        );
      setStage("copying");
      try {
        setCopy(unwrap(await approve({ environmentId: machine, input: { operationId } })));
      } catch (cause) {
        // A refusal (disk space, a changed preview) happens before anything is copied.
        show(await pollCopy(machine, operationId));
        throw cause;
      }
      const next = await pollCopy(machine, operationId);
      show(next);
      if (next.state === "failed") return;
      if (pending.mode === "copy-and-move" && next.projectId)
        await moveCoordinator(operationId, machine, next.projectId, next);
    });

  const retryCopy = () =>
    run(async () => {
      if (!machine || !pending) return;
      const operationId = pending.operationId;
      if (copy?.state === "applied" && copy.projectId && pending.mode === "copy-and-move") {
        await moveCoordinator(operationId, machine, copy.projectId);
        return;
      }
      setStage("copying");
      setCopy(unwrap(await retry({ environmentId: machine, input: { operationId } })));
      const next = await pollCopy(machine, operationId);
      show(next);
      if (next.state !== "failed" && pending.mode === "copy-and-move" && next.projectId)
        await moveCoordinator(operationId, machine, next.projectId, next);
    });

  const stop = () =>
    run(async () => {
      if (!pending) {
        setStage("setup");
        return;
      }
      const operationId = pending.operationId;
      const reason = "The copy was cancelled before Apply.";
      if (machine && copy)
        await cancel({ environmentId: machine, input: { operationId, reason } }).catch(() => null);
      await sourceCancel({ environmentId: project.environmentId, input: { operationId, reason } });
      if (pending.mode === "copy-and-move")
        unwrap(
          await release({
            environmentId: project.environmentId,
            input: { projectId: project.id, operationId, reason },
          }),
        );
      remember(null);
      setOffer(null);
      setSummary(null);
      setCopy(null);
      setStage("setup");
    });

  const undoCopy = (force: boolean, previewOnly: boolean) =>
    run(async () => {
      if (!machine || !pending) return;
      const result = unwrap(
        await undo({
          environmentId: machine,
          input: {
            operationId: pending.operationId,
            preview: previewOnly,
            force,
          },
        }),
      );
      setCopy(result.status);
      if (previewOnly) {
        setUndoPreview(result);
        return;
      }
      setUndoPreview(null);
      if (!result.undone) throw new Error(result.problems.join(" ") || "Undo did not finish.");
      remember(null);
      setStage("undone");
    });

  const fresh = () =>
    run(async () => {
      // A reload may have lost the publish result. The source must confirm that
      // abandoning this operation cannot orphan a fenced coordinator.
      if (pending?.mode === "copy-and-move") {
        unwrap(
          await release({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              operationId: pending.operationId,
              reason: "Starting a fresh copy before transferring coordinator context.",
            },
          }),
        );
      }
      if (copy?.state === "applied" && copy.committed && copy.projectId && machine) {
        // Keep the server's canonical folder and registration across a fresh copy.
        // Creating a second id for that same folder would fail only after Apply.
        const destinationEnvironment =
          (pending?.environmentId as EnvironmentId | undefined) ?? machine;
        copiedProjects.current.set(
          copyDestinationKey(
            destinationEnvironment,
            copy.projectFolder ??
              copiedProjectFolder(
                copy.targetFolder,
                copy.projectRelativePath ?? pending?.projectRelativePath,
              ),
          ),
          copy.projectId,
        );
        setFolder(
          copy.targetFolder,
          destinationEnvironment,
          copy.copyRoot ?? pending?.copyRoot ?? scope.selected.copyRoot,
        );
      }
      setTransferRecovery(false);
      contextPublished.current = false;
      remember(null);
      setOffer(null);
      setSummary(null);
      setCopy(null);
      setUndoPreview(null);
      setLink(null);
      setError(null);
      setTransferNotice(null);
      setContextTransferred(false);
      setCopyAgain(false);
      setSelection(DEFAULT_COPY_SELECTION);
      setSecretPaths([]);
      setSecretsConfirmed(false);
      setStage("setup");
    });

  const failedBeforeApply =
    copy?.state === "failed" && copy.failedStep !== "applying" && copy.failedStep !== "applied";

  return (
    <div className="space-y-4" data-slot="handoff-folder-copy" data-stage={stage}>
      {(stage === "setup" || stage === "scanning") && (
        <>
          <HandoffCopyScope
            scope={scope}
            sourceLabel={sourceLabel}
            disabled={busy || pending !== null}
          />
          <fieldset className="min-w-0 space-y-2" disabled={busy}>
            <legend className="mb-2 text-sm font-medium">Copy to</legend>
            {machines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect another machine in Settings &gt; Connections first.
              </p>
            ) : (
              <RadioGroup
                aria-label="Copy to"
                value={machine ?? ""}
                onValueChange={(value) => {
                  const id = value as EnvironmentId;
                  setMachine(id);
                  setFolderDraft(null);
                }}
              >
                {machines.map((entry) => (
                  <label
                    key={entry.id}
                    data-slot="copy-machine"
                    className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${machine === entry.id ? "border-primary bg-accent/40" : ""} ${entry.unavailable ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                  >
                    <span className="flex h-5 items-center">
                      <Radio value={entry.id} disabled={entry.unavailable !== null} />
                    </span>
                    <span className="min-w-0 leading-5">
                      <span className="block font-medium">{entry.label}</span>
                      {entry.unavailable && (
                        <span className="block text-xs text-muted-foreground">
                          {entry.unavailable}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            )}
          </fieldset>
          <label className="block space-y-1 text-sm" data-slot="copy-folder">
            <span className="font-medium">Folder on {targetLabel}</span>
            <Input
              value={folder}
              placeholder={
                home.isPending
                  ? "Finding the destination home folder…"
                  : "Absolute path on the destination"
              }
              disabled={busy}
              spellCheck={false}
              onChange={(event) => setFolder(event.currentTarget.value)}
              aria-label={`Folder on ${targetLabel}`}
            />
            {scope.selected.projectRelativePath !== "." && folder && (
              <span
                className="block text-xs text-muted-foreground"
                data-slot="copy-destination-project"
              >
                Project / coordinator folder:{" "}
                <span className="font-mono wrap-anywhere">
                  {copiedProjectFolder(folder, scope.selected.projectRelativePath)}
                </span>
              </span>
            )}
            <span className="block text-xs text-muted-foreground">
              A new or empty folder gets an exact copy. An existing folder is compared first and
              nothing there changes without your approval.
            </span>
          </label>
          <fieldset className="min-w-0 space-y-2" disabled={busy}>
            <legend className="mb-2 text-sm font-medium">After the copy</legend>
            <RadioGroup
              aria-label="After the copy"
              value={mode}
              onValueChange={(value) => setMode(value as FolderCopyMode)}
            >
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <span className="flex h-5 items-center">
                  <Radio value="copy-only" />
                </span>
                <span className="leading-5">
                  Copy files only
                  <span className="block text-xs text-muted-foreground">
                    Keeps this coordinator on {sourceLabel}. {targetLabel} gets a separate checkout;
                    you can start its own coordinator in Project settings.
                  </span>
                </span>
              </label>
              <label
                className={`flex items-start gap-3 text-sm ${canMove ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
              >
                <span className="flex h-5 items-center">
                  <Radio value="copy-and-move" disabled={!canMove} />
                </span>
                <span className="leading-5">
                  Copy and transfer coordinator context
                  <span className="block text-xs text-muted-foreground">
                    Copies files first, then transfers this coordinator's context and responsibility
                    to {targetLabel} when source work is idle. Each machine keeps its own server;
                    running workers and provider processes are not moved.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </fieldset>
          {stage === "setup" && pending && (
            <p className="text-sm">
              A copy to {pending.targetFolder} on {targetLabel} is unfinished. Check it again once{" "}
              {targetLabel} is reachable.
            </p>
          )}
        </>
      )}

      {stage !== "setup" && stage !== "scanning" && pending && (
        <CopyScopeMapping
          source={copy?.copyRoot ?? offer?.copyRoot ?? pending.copyRoot ?? project.workspaceRoot}
          target={copy?.targetFolder ?? pending.targetFolder}
          projectFolder={
            copy?.projectFolder ??
            copiedProjectFolder(
              copy?.targetFolder ?? pending.targetFolder,
              copy?.projectRelativePath ?? pending.projectRelativePath,
            )
          }
        />
      )}

      {stage === "select" && summary && (
        <>
          <CopyClassPicker
            summary={summary}
            selection={selection}
            onChange={setSelection}
            disabled={busy}
          />
        </>
      )}

      {stage === "planning" && (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Comparing with {pending?.targetFolder ?? "the folder"} on {targetLabel}…
        </p>
      )}

      {stage === "preview" && copy && (
        <>
          <CopyPlanPreview
            status={copy}
            disabled={busy}
            onDecide={(decisions) => void change({ decisions })}
            onClone={(rowId, on) =>
              void change({
                clone: on
                  ? [...copy.rows.filter((row) => row.clone).map((row) => row.id), rowId]
                  : copy.rows.filter((row) => row.clone && row.id !== rowId).map((row) => row.id),
              })
            }
          />
          {copy.disk && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {targetLabel} needs {formatBytes(copy.disk.needed)} free for this copy and has{" "}
              {formatBytes(copy.disk.free)}.
            </p>
          )}
          {summary && (
            <HandoffSecretsStep
              files={summary.secretFiles}
              selected={secretPaths}
              confirmed={secretsConfirmed}
              targetLabel={targetLabel}
              disabled={busy}
              onSelectedChange={setSecretPaths}
              onConfirmedChange={setSecretsConfirmed}
            />
          )}
        </>
      )}

      {(stage === "copying" || stage === "moving") && copy && (
        <>
          {stage === "moving" ? (
            <p role="status" aria-live="polite" className="text-sm">
              Files are in place. Starting the coordinator on {targetLabel}…
            </p>
          ) : (
            <CopyProgress status={copy} />
          )}
        </>
      )}

      {stage === "failed" && copy && (
        <div className="space-y-2 text-sm">
          <p role="alert" className="wrap-anywhere text-destructive-foreground">
            {copy.state === "applied"
              ? `The files are in ${copy.targetFolder}, but the coordinator did not start there.`
              : (copy.error?.message ?? "The copy stopped.")}
            {failedBeforeApply ? ` Nothing in ${copy.targetFolder} changed.` : ""}
          </p>
        </div>
      )}

      {stage === "done" && copy && copy.projectId && (
        <div className="space-y-3 text-sm" data-slot="copy-done">
          <p role="status">
            {mode === "copy-and-move" && contextTransferred
              ? `The coordinator continues on ${targetLabel} in ${copy.projectFolder ?? copiedProjectFolder(copy.targetFolder, copy.projectRelativePath)}.`
              : mode === "copy-and-move"
                ? `${targetLabel} has a copy in ${copy.targetFolder}. Coordinator context has not finished transferring.`
                : `${targetLabel} has a copy in ${copy.targetFolder}. The coordinator stays on ${sourceLabel}.`}
          </p>
          {transferNotice && (
            <p role="status" className="text-xs text-warning-foreground">
              {transferNotice}
            </p>
          )}
          {mode === "copy-only" && link && (
            <p
              className="text-muted-foreground text-xs wrap-anywhere"
              role={link.status === "review" ? "alert" : "status"}
              data-slot="copy-link"
            >
              {link.status === "linking"
                ? `Linking the copy on ${targetLabel} so it runs workers for ${sourceLabel}…`
                : link.status === "linked"
                  ? `Linked: the copy on ${targetLabel} runs workers; the coordinator on ${sourceLabel} sends it work.`
                  : `Not linked yet. ${link.reason}`}
            </p>
          )}
          {copy.checks.some((check) => !check.ok) && (
            <ul className="space-y-1 text-xs">
              {copy.checks
                .filter((check) => !check.ok)
                .map((check) => (
                  <li key={check.repo} className="wrap-anywhere">
                    {check.repo}: {check.problems.join(" ")}
                  </li>
                ))}
            </ul>
          )}
          {copy.secrets && copy.secrets.length > 0 && (
            <ul className="space-y-1 text-xs" aria-label="Secret files sent">
              {copy.secrets.map((secret) => (
                <li key={secret.path} className="wrap-anywhere">
                  <span className="font-mono">{secret.writtenAs}</span>
                  {secret.state === "beside"
                    ? ` was written beside ${secret.path}, which differs on ${targetLabel}.`
                    : secret.state === "unchanged"
                      ? " was already the same."
                      : " is in place, readable only by you."}
                </li>
              ))}
            </ul>
          )}
          {undoPreview && <CopyUndoPreview result={undoPreview} />}
          <MachineReadinessChecklist
            environmentId={machine!}
            environmentLabel={targetLabel}
            projectId={copy.projectId}
          />
          {mode === "copy-only" && copy.backupsDiscardedAt !== undefined && (
            <p className="text-muted-foreground text-xs">
              The backups from this copy were removed after 14 days, so it can no longer be undone.
            </p>
          )}

          {linkDialog && machine && (
            <ProjectLinkDialog
              open
              onOpenChange={(open) => !open && setLinkDialog(false)}
              project={project}
              initialCandidate={{ environmentId: machine, projectId: copy.projectId }}
              initialKept="here"
              autoReview
              onLinked={() => setLink({ status: "linked" })}
            />
          )}
        </div>
      )}

      {stage === "undone" && (
        <div className="space-y-2 text-sm">
          <p role="status">
            {copy?.state === "undone"
              ? `${copy.targetFolder} is back to how it was before the copy.`
              : "The copy was cancelled."}
          </p>
        </div>
      )}

      <HandoffCopyActions>
        {error && (
          <p
            role="alert"
            className="max-h-24 basis-full overflow-y-auto wrap-anywhere text-sm text-destructive-foreground"
          >
            {error}
          </p>
        )}
        {(stage === "setup" || stage === "scanning") &&
          (stage === "setup" && pending ? (
            <Button disabled={busy} onClick={() => resume(pending)}>
              Check the copy again
            </Button>
          ) : (
            <Button
              disabled={
                busy || scope.loading || !machine || !!target?.unavailable || !folder.trim()
              }
              onClick={() => void measure()}
            >
              {stage === "scanning" ? "Measuring the folder…" : "Measure the folder"}
            </Button>
          ))}
        {(stage === "select" || stage === "planning") && (
          <>
            <Button disabled={busy || selection.length === 0} onClick={() => void plan()}>
              {stage === "planning" ? "Comparing folders…" : `Preview on ${targetLabel}`}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void stop()}>
              Cancel copy
            </Button>
          </>
        )}
        {stage === "preview" && copy && (
          <>
            <Button
              disabled={
                busy ||
                (copy.totals?.decisionsNeeded ?? 1) > 0 ||
                (secretPaths.length > 0 && !secretsConfirmed)
              }
              onClick={() => void apply()}
            >
              {mode === "copy-and-move"
                ? `Copy and transfer context to ${targetLabel}`
                : `Copy and apply on ${targetLabel}`}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void stop()}>
              Cancel copy
            </Button>
          </>
        )}
        {(stage === "copying" || stage === "moving") && (
          <>
            <Button disabled>
              {stage === "moving"
                ? "Transferring context…"
                : copy?.state === "applying"
                  ? "Applying files…"
                  : "Copying files…"}
            </Button>
            {stage === "copying" &&
              copy &&
              copy.state !== "applying" &&
              copy.state !== "applied" && (
                <Button variant="outline" disabled={working} onClick={() => void stop()}>
                  Cancel copy
                </Button>
              )}
          </>
        )}
        {stage === "failed" && copy && (
          <>
            <Button disabled={busy} onClick={() => void retryCopy()}>
              Retry
            </Button>
            {failedBeforeApply && (
              <Button variant="outline" disabled={busy} onClick={() => void stop()}>
                Cancel copy
              </Button>
            )}
          </>
        )}
        {stage === "done" && copy && copy.projectId && (
          <>
            {copyAgain && (
              <Button disabled={busy} onClick={fresh}>
                Copy again
              </Button>
            )}
            {mode === "copy-and-move" && !contextTransferred && !copyAgain && pending && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() => moveCoordinator(pending.operationId, machine!, copy.projectId!))
                }
              >
                Transfer coordinator context
              </Button>
            )}
            <Button
              variant={mode === "copy-and-move" && !contextTransferred ? "outline" : "default"}
              onClick={() =>
                onOpenProject({
                  environmentId: machine!,
                  projectId: copy.projectId!,
                  folder:
                    copy.projectFolder ??
                    copiedProjectFolder(
                      copy.targetFolder,
                      copy.projectRelativePath ?? pending?.projectRelativePath,
                    ),
                })
              }
            >
              Open on {targetLabel}
            </Button>
            {mode === "copy-only" &&
              pending &&
              copy.backupsDiscardedAt === undefined &&
              (undoPreview ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void undoCopy(undoPreview.edited > 0, false)}
                >
                  {undoPreview.edited > 0 ? "Undo and keep edited files aside" : "Undo the copy"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void undoCopy(false, true)}
                >
                  Undo…
                </Button>
              ))}
            {mode === "copy-only" && link?.status === "review" && (
              <Button variant="outline" disabled={busy} onClick={() => setLinkDialog(true)}>
                Link…
              </Button>
            )}
            <Button variant="ghost" disabled={busy || transferRecovery} onClick={fresh}>
              Start a new copy
            </Button>
          </>
        )}
        {stage === "undone" && (
          <Button variant="outline" onClick={fresh}>
            Start a new copy
          </Button>
        )}
      </HandoffCopyActions>
    </div>
  );
}
