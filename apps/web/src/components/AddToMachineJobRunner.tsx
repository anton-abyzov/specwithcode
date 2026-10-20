import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import type { AtomCommandResult } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  logicalProjectTitle,
  type EnvironmentId,
  type FolderCopyStatus,
  type ProjectId,
  type SourceControlInspectDestinationResult,
} from "@specweave-studio/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { readProject, useAllEnvironmentProjectSnapshotsReady, useProjects } from "~/state/entities";
import { useEnvironment, useEnvironments } from "~/state/environments";
import { useEnvironmentProjectClones } from "~/state/projectClones";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  addToMachineJobKey,
  clearAddToMachineJob,
  cloneUrlsFor,
  listAddToMachineJobs,
  type AddToMachineJob,
} from "~/studio/addToMachine";
import {
  ADD_TO_MACHINE_JOBS_EVENT,
  addCopySelection,
  applyCopy,
  cancelCopy,
  copyApplied,
  type CopyCommands,
  isTransient,
  keepMineDecisions,
  messageOf,
  notifyAddToMachineJobs,
  offerAndScan,
  pollCopy,
  readAddToMachineCopy,
  startCopy,
  unwrap,
  useCopyCommands,
  useLinkCommands,
  writeAddToMachineCopy,
} from "~/studio/addToMachineCopy";
import { useMachineNicknames } from "~/studio/machineNickname";
import { linkCopyAsWorkers } from "~/studio/projectLink";
import { ProjectLinkDialog } from "./studio/ProjectLinkDialog";
import { toastManager } from "./ui/toast";
import { stackedThreadToast } from "./ui/toastHelpers";

/** Clone snapshots stay on the server this long after "done"; older jobs are checked on disk. */
const CLONE_DONE_RETENTION_MS = 30_000;

/** One pass per job per page load: a failure waits for a reload instead of retrying in a loop. */
const attempted = new Set<string>();

interface LinkReview {
  readonly source: EnvironmentProject;
  readonly destination: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
}

/**
 * Finishes Run on → Add to another machine after the clone is done: copies the
 * ignored and secret files the user ticked, then links the clone as a worker
 * copy (AC-03, AC-08). Jobs live in localStorage, so a reload resumes them.
 */
export function AddToMachineJobRunner() {
  const [jobs, setJobs] = useState(listAddToMachineJobs);
  const [review, setReview] = useState<LinkReview | null>(null);
  useEffect(() => {
    const refresh = () => setJobs(listAddToMachineJobs());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.includes("add-to-machine")) refresh();
    };
    refresh();
    window.addEventListener("storage", onStorage);
    window.addEventListener(ADD_TO_MACHINE_JOBS_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(ADD_TO_MACHINE_JOBS_EVENT, refresh);
    };
  }, []);

  const byDestination = useMemo(() => {
    const groups = new Map<EnvironmentId, AddToMachineJob[]>();
    for (const job of jobs) {
      const list = groups.get(job.destination.environmentId) ?? [];
      list.push(job);
      groups.set(job.destination.environmentId, list);
    }
    return groups;
  }, [jobs]);

  return (
    <>
      {[...byDestination].map(([environmentId, list]) => (
        <DestinationJobsGate
          key={environmentId}
          environmentId={environmentId}
          jobs={list}
          onReview={setReview}
        />
      ))}
      {review && (
        <ProjectLinkDialog
          open
          onOpenChange={(open) => !open && setReview(null)}
          project={review.source}
          initialCandidate={review.destination}
          initialKept="here"
          autoReview
          onLinked={() => setReview(null)}
        />
      )}
    </>
  );
}

function DestinationJobsGate(props: {
  readonly environmentId: EnvironmentId;
  readonly jobs: ReadonlyArray<AddToMachineJob>;
  readonly onReview: (review: LinkReview) => void;
}) {
  const environment = useEnvironment(props.environmentId);
  // Clone progress needs a connected destination that tracks clones.
  if (environment?.serverConfig?.environment.capabilities.projectCloneTracking !== true)
    return null;
  return <DestinationJobs {...props} />;
}

function DestinationJobs({
  environmentId,
  jobs,
  onReview,
}: {
  readonly environmentId: EnvironmentId;
  readonly jobs: ReadonlyArray<AddToMachineJob>;
  readonly onReview: (review: LinkReview) => void;
}) {
  const clones = useEnvironmentProjectClones(environmentId);
  const stream = useAtomValue(
    useMemo(
      () => sourceControlEnvironment.projectClones({ environmentId, input: {} }),
      [environmentId],
    ),
  );
  const delivered = AsyncResult.isSuccess(stream);
  const projects = useProjects();
  const projectsReady = useAllEnvironmentProjectSnapshotsReady();
  const { environments } = useEnvironments();
  const names = useMachineNicknames();
  const commands = useCopyCommands();
  const linkCommands = useLinkCommands();
  const inspectDestination = useAtomCommand(sourceControlEnvironment.inspectDestination, {
    reportFailure: false,
  });
  const [now, setNow] = useState(() => Date.now());

  const latest = useRef({
    commands,
    linkCommands,
    inspectDestination,
    environments,
    names,
    onReview,
  });
  useEffect(() => {
    latest.current = { commands, linkCommands, inspectDestination, environments, names, onReview };
  });

  useEffect(() => {
    let next = Number.POSITIVE_INFINITY;
    const later = (ms: number) => {
      next = Math.min(next, Math.max(ms, 0));
    };
    for (const job of jobs) {
      const key = addToMachineJobKey(job.destination.environmentId, job.destination.projectId);
      if (attempted.has(key)) continue;
      const clone = clones.find((entry) => entry.projectId === job.destination.projectId);
      // ChatView offers Retry and Remove for a failed or cancelled clone.
      if (clone && clone.phase !== "done") continue;
      const exists = projects.some(
        (project) =>
          project.environmentId === environmentId && project.id === job.destination.projectId,
      );
      const age = now - Date.parse(job.createdAt);
      if (!exists) {
        if (projectsReady && delivered && !clone && age > CLONE_DONE_RETENTION_MS) {
          attempted.add(key);
          finish(job);
        } else if (!clone) later(CLONE_DONE_RETENTION_MS - age + 1000);
        continue;
      }
      if (!clone) {
        if (!delivered) continue;
        // No snapshot yet, or it expired: wait out the retention, then check the folder.
        if (age <= CLONE_DONE_RETENTION_MS) {
          later(CLONE_DONE_RETENTION_MS - age + 1000);
          continue;
        }
      }
      attempted.add(key);
      void runJob(job, { verify: !clone, ...latest.current });
    }
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), next);
    return () => clearTimeout(timer);
  }, [jobs, clones, delivered, projects, projectsReady, environmentId, now]);

  return null;
}

function finish(job: AddToMachineJob): void {
  clearAddToMachineJob(job.destination.environmentId, job.destination.projectId);
  writeAddToMachineCopy(job.destination.environmentId, job.destination.projectId, null);
  notifyAddToMachineJobs();
}

interface RunContext {
  readonly verify: boolean;
  readonly commands: CopyCommands;
  readonly linkCommands: ReturnType<typeof useLinkCommands>;
  readonly inspectDestination: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly path: string; readonly remoteUrl?: string };
  }) => Promise<AtomCommandResult<SourceControlInspectDestinationResult, unknown>>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly names: ReturnType<typeof useMachineNicknames>;
  readonly onReview: (review: LinkReview) => void;
}

async function runJob(job: AddToMachineJob, context: RunContext): Promise<void> {
  const label = (environmentId: EnvironmentId) =>
    context.names(
      environmentId,
      context.environments.find((entry) => entry.environmentId === environmentId)?.label,
    );
  const sourceName = label(job.source.environmentId);
  const destName = label(job.destination.environmentId);
  const source = readProject(scopeProjectRef(job.source.environmentId, job.source.projectId));
  if (!source) {
    finish(job);
    return;
  }
  const title = logicalProjectTitle(source);

  if (context.verify) {
    const urls = source.repositoryIdentity ? cloneUrlsFor(source.repositoryIdentity) : null;
    const remoteUrl = urls ? (urls.https ?? urls.ssh ?? urls.raw) : null;
    const inspected = await context.inspectDestination({
      environmentId: job.destination.environmentId,
      input: { path: job.destination.workspaceRoot, ...(remoteUrl ? { remoteUrl } : {}) },
    });
    if (inspected._tag !== "Success") return;
    const found = inspected.value;
    if (found.state === "missing" || found.state === "empty") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `${title} did not finish copying to ${destName}`,
          description: `${found.path} is empty. Add the project to ${destName} again from Run on.`,
        }),
      );
      finish(job);
      return;
    }
    // A clone writes its origin before it fetches, so the origin alone does not
    // prove a finished clone. Leave the job for the next load rather than copy
    // into or link a half-done folder.
    if (found.state !== "repository" || !found.sameRepository) return;
    if (!found.checkedOut) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `${title} is not fully copied to ${destName}`,
          description: `${found.path} has no checked-out files yet. SpecWithCode checks again the next time it opens.`,
        }),
      );
      return;
    }
  }

  if (job.copyIgnored || job.secrets.length > 0) {
    try {
      await copyExtras(job, context.commands, destName);
    } catch (cause) {
      const transient = isTransient(cause);
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `Extra files were not copied to ${destName}`,
          description: transient
            ? `${messageOf(cause)} SpecWithCode tries again the next time it opens.`
            : messageOf(cause),
        }),
      );
      if (transient) return;
    }
  }

  const destination = {
    environmentId: job.destination.environmentId,
    projectId: job.destination.projectId,
  };
  const openReview = () => context.onReview({ source, destination });
  try {
    const outcome = await linkCopyAsWorkers(context.linkCommands, {
      kept: { environmentId: job.source.environmentId, projectId: job.source.projectId },
      joining: destination,
      keptLabel: sourceName,
      joiningLabel: destName,
      newOperationId: randomUUID,
    });
    finish(job);
    if (outcome.status === "review")
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `${title} on ${destName} is not linked yet`,
          description: outcome.reason,
          actionProps: { children: "Link…", onClick: openReview },
        }),
      );
  } catch (cause) {
    const transient = isTransient(cause);
    if (!transient) finish(job);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `${title} on ${destName} is not linked yet`,
        description: transient
          ? `${messageOf(cause, "Linking stopped.")} SpecWithCode tries again the next time it opens.`
          : messageOf(cause, "Linking stopped."),
        actionProps: { children: "Link…", onClick: openReview },
      }),
    );
  }
}

/** Copies ignored and ticked secret files into the fresh clone, keeping what the clone has. */
async function copyExtras(
  job: AddToMachineJob,
  commands: CopyCommands,
  destName: string,
): Promise<void> {
  const { source, destination } = job;
  const env = destination.environmentId;
  const previous = readAddToMachineCopy(env, destination.projectId);
  if (previous) {
    const known = await commands.status({ environmentId: env, input: { operationId: previous } });
    let status: FolderCopyStatus | null = known._tag === "Success" ? known.value : null;
    if (status && !["previewed", "failed", "cancelled", "undone", "applied"].includes(status.state))
      status = await pollCopy(commands, env, previous, {});
    if (status && (copyApplied(status) || status.state === "applied" || status.state === "undone"))
      return;
    // Stopped before Apply: withdraw it and start over, so nothing is copied twice.
    await cancelCopy(commands, {
      sourceEnvironmentId: source.environmentId,
      destinationEnvironmentId: env,
      operationId: previous,
      reason: "Restarting the copy after a reload.",
    });
  }

  const operationId = randomUUID();
  writeAddToMachineCopy(env, destination.projectId, operationId);
  const { offer, summary } = await offerAndScan(commands, {
    source: { environmentId: source.environmentId, projectId: source.projectId },
    destinationEnvironmentId: env,
    operationId,
  });
  let status = await startCopy(commands, {
    offer,
    destinationEnvironmentId: env,
    targetFolder: destination.workspaceRoot,
    selection: addCopySelection("clone", job.copyIgnored),
  });
  if (status.state !== "previewed") throw new Error(status.error?.message ?? "The copy stopped.");
  const decisions = keepMineDecisions(status);
  if (Object.keys(decisions).length > 0) {
    unwrap(await commands.decide({ environmentId: env, input: { operationId, decisions } }));
    status = await pollCopy(commands, env, operationId, {});
  }
  if ((status.totals?.decisionsNeeded ?? 0) > 0) {
    await cancelCopy(commands, {
      sourceEnvironmentId: source.environmentId,
      destinationEnvironmentId: env,
      operationId,
      reason: "Some files need a choice.",
    });
    throw new Error(
      `Some files differ on ${destName} and need your choice. Copy them from the project's machine settings.`,
    );
  }
  const secrets = job.secrets.filter((path) =>
    summary.secretFiles.some((file) => file.path === path),
  );
  const done = await applyCopy(commands, {
    sourceEnvironmentId: source.environmentId,
    destinationEnvironmentId: env,
    destinationLabel: destName,
    operationId,
    secrets,
  });
  if (done.state !== "applied") throw new Error(done.error?.message ?? "The copy stopped.");
}
