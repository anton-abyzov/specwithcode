import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  logicalProjectTitle,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type FolderCopyOffer,
  type FolderCopySourceSummary,
  type FolderCopyStatus,
  type ProjectId,
  type SourceControlInspectDestinationResult,
} from "@specweave-studio/contracts";
import { ArrowRightIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { newProjectId, randomUUID } from "~/lib/utils";
import { waitForProject } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  cloneUrlFor,
  cloneUrlsFor,
  defaultDestinationFolder,
  destinationPlan,
  IGNORED_FILES_NOTE,
  writeAddToMachineJob,
  type CloneProtocol,
} from "~/studio/addToMachine";
import {
  addCopySelection,
  cancelCopy,
  isAbort,
  isCopyError,
  messageOf,
  notifyAddToMachineJobs,
  offerAndScan,
  startCopy,
  unwrap,
  useCopyCommands,
} from "~/studio/addToMachineCopy";
import { useMachineNicknames } from "~/studio/machineNickname";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { HandoffSecretsStep } from "../studio/HandoffSecretsStep";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { AddToMachineConsolidate } from "./AddToMachineConsolidate";

const INSPECT_DEBOUNCE_MS = 300;

export interface AddToMachineDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly source: EnvironmentProject;
  readonly destinationEnvironmentId: EnvironmentId;
  readonly onAdded: (target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => void;
}

/** What the open dialog tells its wrapper: whether closing is allowed, and what closing does. */
interface CloseGuard {
  busy: boolean;
  onClose: (() => void) | null;
}

/**
 * Run on → Add to another machine (AC-03..AC-08): clone the project's repository
 * onto a machine that lacks it, or link and consolidate a checkout already there.
 */
export function AddToMachineDialog(props: AddToMachineDialogProps) {
  const guard = useRef<CloseGuard>({ busy: false, onClose: null });
  const setGuard = useCallback((patch: Partial<CloseGuard>) => {
    Object.assign(guard.current, patch);
  }, []);
  const { onOpenChange } = props;
  const change = (next: boolean) => {
    if (!next) {
      if (guard.current.busy) return;
      const onClose = guard.current.onClose;
      guard.current = { busy: false, onClose: null };
      onClose?.();
    }
    onOpenChange(next);
  };
  return (
    <Dialog open={props.open} onOpenChange={change}>
      <DialogPopup className="max-w-lg" data-testid="add-to-machine-dialog">
        {props.open && (
          <AddToMachineBody {...props} setGuard={setGuard} close={() => change(false)} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

type Inspection =
  | { readonly key: string; readonly result: SourceControlInspectDestinationResult }
  | { readonly key: string; readonly error: string };

type Scan =
  | { readonly state: "scanning" }
  | {
      readonly state: "ready";
      readonly offer: FolderCopyOffer;
      readonly summary: FolderCopySourceSummary;
    }
  | { readonly state: "failed"; readonly message: string };

type Stage =
  | { readonly kind: "setup" }
  | { readonly kind: "started" }
  | {
      readonly kind: "consolidate";
      readonly offer: FolderCopyOffer;
      readonly summary: FolderCopySourceSummary;
      readonly status: FolderCopyStatus;
    };

export function remoteAccessMessage(machine: string, detail: string | null): string {
  const fix = `${machine} can't read this repository. Sign in to GitHub on ${machine} (gh auth login or an SSH key), then try again.`;
  return detail ? `${fix} ${detail}` : fix;
}

function AddToMachineBody({
  source,
  destinationEnvironmentId: destination,
  onAdded,
  setGuard,
  close,
}: AddToMachineDialogProps & {
  readonly setGuard: (patch: Partial<CloseGuard>) => void;
  readonly close: () => void;
}) {
  const sourceEnvironment = useEnvironment(source.environmentId);
  const destinationEnvironment = useEnvironment(destination);
  const names = useMachineNicknames();
  const sourceName = names(source.environmentId, sourceEnvironment?.label);
  const destName = names(destination, destinationEnvironment?.label);
  const title = logicalProjectTitle(source);
  const capabilities = destinationEnvironment?.serverConfig?.environment.capabilities;
  const connected = destinationEnvironment?.serverConfig != null;
  const checksSupported = capabilities?.cloneDestinationChecks === true;
  const linkSupported =
    capabilities?.projectLink === true &&
    sourceEnvironment?.serverConfig?.environment.capabilities.projectLink === true;

  const urls = useMemo(
    () => (source.repositoryIdentity ? cloneUrlsFor(source.repositoryIdentity) : null),
    [source.repositoryIdentity],
  );
  const [protocol, setProtocol] = useState<CloneProtocol>(() => urls?.preferred ?? "https");
  const remoteUrl = urls ? cloneUrlFor(urls, protocol) : null;
  const [folder, setFolder] = useState(() => defaultDestinationFolder(source.workspaceRoot));
  const [copyIgnored, setCopyIgnored] = useState(false);
  const [secrets, setSecrets] = useState<ReadonlyArray<string>>([]);
  const [secretsConfirmed, setSecretsConfirmed] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [scan, setScan] = useState<Scan>({ state: "scanning" });
  const [scanRound, setScanRound] = useState(0);
  const [stage, setStage] = useState<Stage>({ kind: "setup" });
  const [busy, setBusy] = useState(false);
  const [childBusy, setChildBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkRemoteAccess = useAtomCommand(sourceControlEnvironment.checkRemoteAccess, {
    reportFailure: false,
  });
  const inspectDestination = useAtomCommand(sourceControlEnvironment.inspectDestination, {
    reportFailure: false,
  });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const commands = useCopyCommands();
  const latest = useRef({ commands, inspectDestination, sourceName });
  useEffect(() => {
    latest.current = { commands, inspectDestination, sourceName };
  });

  // The dialog's copy offer: withdrawn on close unless a consolidation applied it.
  const offerRef = useRef<{
    operationId: string;
    destinationStarted: boolean;
    applied: boolean;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setGuard({ busy: busy || childBusy });
  }, [busy, childBusy, setGuard]);

  const folderPath = folder.trim();
  const inspectionKey = JSON.stringify([folderPath, remoteUrl]);
  const ready = connected && checksSupported && remoteUrl !== null;

  useEffect(() => {
    if (!ready || folderPath === "" || remoteUrl === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void latest.current
        .inspectDestination({ environmentId: destination, input: { path: folderPath, remoteUrl } })
        .then((result) => {
          if (!live) return;
          if (result._tag === "Success")
            setInspection({ key: inspectionKey, result: result.value });
          else if (!isAtomCommandInterrupted(result))
            setInspection({
              key: inspectionKey,
              error: messageOf(
                squashAtomCommandFailure(result),
                `${destName} could not check that folder.`,
              ),
            });
        });
    }, INSPECT_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ready, folderPath, remoteUrl, inspectionKey, destination, destName]);

  // Secret-like files are listed by a source-side scan; nothing happens on the destination yet.
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const operationId = randomUUID();
    const sourceEnvironmentId = source.environmentId;
    offerRef.current = { operationId, destinationStarted: false, applied: false };
    offerAndScan(latest.current.commands, {
      source: { environmentId: sourceEnvironmentId, projectId: source.id },
      destinationEnvironmentId: destination,
      operationId,
      signal: controller.signal,
    }).then(
      ({ offer, summary }) => {
        if (!controller.signal.aborted) setScan({ state: "ready", offer, summary });
      },
      (cause: unknown) => {
        if (controller.signal.aborted || isAbort(cause)) return;
        const { sourceName } = latest.current;
        setScan({
          state: "failed",
          message: isCopyError(cause, "no_private_url")
            ? `${sourceName} has no private address yet, so files can't be copied from it. Turn on remote access for ${sourceName} in Settings > Connections, then try again.`
            : messageOf(cause, `${sourceName} could not list the project's files.`),
        });
      },
    );
    return () => {
      controller.abort();
      setScan({ state: "scanning" });
      const current = offerRef.current;
      if (current?.operationId !== operationId || current.applied) return;
      offerRef.current = null;
      void cancelCopy(latest.current.commands, {
        sourceEnvironmentId,
        destinationEnvironmentId: current.destinationStarted ? destination : null,
        operationId,
        reason: "Add to another machine was closed.",
      });
    };
    // scanRound restarts the scan after a cancelled consolidation used up the offer.
  }, [ready, scanRound, source.environmentId, source.id, destination]);

  const current = inspection?.key === inspectionKey ? inspection : null;
  const result = current && "result" in current ? current.result : null;
  const plan = result ? destinationPlan(result) : null;
  const secretFiles = scan.state === "ready" ? scan.summary.secretFiles : [];
  const extrasBlocked = scan.state === "failed";
  const secretsReady = secrets.length === 0 || secretsConfirmed;
  const locked = busy || stage.kind !== "setup";

  const blocker = !connected
    ? `${destName} is not connected. Connect it, then try again.`
    : !checksSupported
      ? `${destName} needs a newer SpecWithCode to add projects. Update SpecWithCode on ${destName}, then try again.`
      : !urls
        ? `This project has no Git remote, so ${destName} has nothing to clone from. Push it to GitHub or another host first.`
        : null;

  const run = async (work: (signal: AbortSignal | undefined) => Promise<void>) => {
    setBusy(true);
    setError(null);
    const signal = abortRef.current?.signal;
    try {
      await work(signal);
    } catch (cause) {
      if (!isAbort(cause) && !signal?.aborted) setError(messageOf(cause, "Something went wrong."));
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  };

  /** AC-04 and AC-06 again at click time: the folder or the sign-in may have changed. */
  const precheck = async () => {
    if (remoteUrl === null) return null;
    const access = unwrap(
      await checkRemoteAccess({ environmentId: destination, input: { remoteUrl } }),
    );
    if (access.status !== "ok") {
      setError(remoteAccessMessage(destName, access.detail));
      return null;
    }
    const inspected = unwrap(
      await inspectDestination({
        environmentId: destination,
        input: { path: folderPath, remoteUrl },
      }),
    );
    setInspection({ key: inspectionKey, result: inspected });
    return { remoteUrl, inspected, plan: destinationPlan(inspected) };
  };

  const clone = () =>
    run(async () => {
      const checked = await precheck();
      if (!checked || checked.plan.kind !== "clone") return;
      const projectId = newProjectId();
      const started = await startProjectClone({
        environmentId: destination,
        input: {
          projectId,
          title: source.title,
          createdAt: new Date().toISOString(),
          remoteUrl: checked.remoteUrl,
          destinationPath: checked.inspected.path,
        },
      });
      if (started._tag === "Failure") {
        if (!isAtomCommandInterrupted(started))
          setError(messageOf(squashAtomCommandFailure(started), "The clone could not start."));
        return;
      }
      setStage({ kind: "started" });
      writeAddToMachineJob({
        version: 1,
        source: {
          environmentId: source.environmentId,
          projectId: source.id,
          workspaceRoot: source.workspaceRoot,
        },
        destination: {
          environmentId: destination,
          projectId,
          workspaceRoot: checked.inspected.path,
        },
        copyIgnored: copyIgnored && !extrasBlocked,
        secrets: extrasBlocked ? [] : secrets,
        createdAt: new Date().toISOString(),
      });
      notifyAddToMachineJobs();
      try {
        await waitForProject(scopeProjectRef(destination, projectId), 10_000);
      } catch {
        throw new Error(
          `The clone started on ${destName}, but the project has not shown up here yet. It appears in the sidebar once it does.`,
        );
      }
      onAdded({ environmentId: destination, projectId });
    });

  const consolidate = () =>
    run(async (signal) => {
      if (scan.state !== "ready" || !offerRef.current) return;
      const checked = await precheck();
      if (!checked || checked.plan.kind !== "consolidate") return;
      offerRef.current.destinationStarted = true;
      const status = await startCopy(commands, {
        offer: scan.offer,
        destinationEnvironmentId: destination,
        targetFolder: checked.inspected.path,
        selection: addCopySelection("consolidate", copyIgnored),
        ...(signal ? { signal } : {}),
      });
      setStage({ kind: "consolidate", offer: scan.offer, summary: scan.summary, status });
    });

  if (stage.kind === "consolidate")
    return (
      <AddToMachineConsolidate
        source={source}
        sourceName={sourceName}
        destinationEnvironmentId={destination}
        destName={destName}
        offer={stage.offer}
        summary={stage.summary}
        initialStatus={stage.status}
        secrets={secrets}
        commands={commands}
        onBusyChange={setChildBusy}
        onApplied={() => {
          if (offerRef.current) offerRef.current.applied = true;
        }}
        onLinked={(projectId) => {
          setGuard({ onClose: () => onAdded({ environmentId: destination, projectId }) });
        }}
        onUndone={() => {
          setGuard({ onClose: null });
        }}
        onCancelled={() => {
          offerRef.current = null;
          setSecrets([]);
          setSecretsConfirmed(false);
          setStage({ kind: "setup" });
          setScanRound((round) => round + 1);
        }}
        onClose={close}
      />
    );

  const primary =
    plan?.kind === "consolidate" ? (
      <Button
        disabled={locked || !ready || !linkSupported || scan.state !== "ready" || !secretsReady}
        onClick={() => void consolidate()}
      >
        Link and consolidate
      </Button>
    ) : (
      <Button
        disabled={
          locked ||
          !ready ||
          plan?.kind !== "clone" ||
          capabilities?.projectCloneTracking !== true ||
          !secretsReady
        }
        onClick={() => void clone()}
      >
        Clone to {destName}
      </Button>
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Add {title} to {destName}
        </DialogTitle>
        <DialogDescription>
          {destName} gets its own checkout. The coordinator stays on {sourceName} and sends it work.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-4">
          <div className="flex min-w-0 items-center gap-2 text-sm" data-slot="add-route">
            <MachinePlace
              kind={resolveEnvironmentMachineKind(sourceEnvironment?.serverConfig ?? null)}
              name={sourceName}
              path={source.workspaceRoot}
            />
            <ArrowRightIcon aria-label="to" className="size-4 shrink-0 text-muted-foreground" />
            <MachinePlace
              kind={resolveEnvironmentMachineKind(destinationEnvironment?.serverConfig ?? null)}
              name={destName}
              path={result?.path ?? folderPath}
            />
          </div>

          {blocker ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {blocker}
            </p>
          ) : (
            <SetupFields
              destName={destName}
              sourceName={sourceName}
              urls={urls!}
              protocol={protocol}
              onProtocolChange={setProtocol}
              remoteUrl={remoteUrl!}
              folder={folder}
              onFolderChange={setFolder}
              disabled={locked}
              inspectionError={current && "error" in current ? current.error : null}
              plan={plan}
              linkSupported={linkSupported}
              copyIgnored={copyIgnored}
              onCopyIgnoredChange={setCopyIgnored}
              scan={scan}
            />
          )}

          {!blocker && !extrasBlocked && (
            <HandoffSecretsStep
              files={secretFiles}
              selected={secrets}
              confirmed={secretsConfirmed}
              targetLabel={destName}
              disabled={locked}
              onSelectedChange={setSecrets}
              onConfirmedChange={setSecretsConfirmed}
            />
          )}

          {stage.kind === "started" && !error && (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              Cloning on {destName}…
            </p>
          )}
          {busy && stage.kind === "setup" && (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              Checking that {destName} can read the repository…
            </p>
          )}
          {error && (
            <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
              {error}
            </p>
          )}
        </div>
      </DialogPanel>
      {stage.kind === "setup" && (
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {primary}
        </DialogFooter>
      )}
    </>
  );
}

function MachinePlace({
  kind,
  name,
  path,
}: {
  readonly kind: Parameters<typeof EnvironmentMachineIcon>[0]["kind"];
  readonly name: string;
  readonly path: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2 rounded-lg border px-2.5 py-2">
      <EnvironmentMachineIcon kind={kind} aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="truncate font-medium">{name}</p>
        <p className="wrap-anywhere font-mono text-muted-foreground text-xs">{path}</p>
      </div>
    </div>
  );
}

function SetupFields(props: {
  readonly destName: string;
  readonly sourceName: string;
  readonly urls: ReturnType<typeof cloneUrlsFor>;
  readonly protocol: CloneProtocol;
  readonly onProtocolChange: (protocol: CloneProtocol) => void;
  readonly remoteUrl: string;
  readonly folder: string;
  readonly onFolderChange: (folder: string) => void;
  readonly disabled: boolean;
  readonly inspectionError: string | null;
  readonly plan: ReturnType<typeof destinationPlan> | null;
  readonly linkSupported: boolean;
  readonly copyIgnored: boolean;
  readonly onCopyIgnoredChange: (on: boolean) => void;
  readonly scan: Scan;
}) {
  const folderId = useId();
  const { urls, plan, destName } = props;
  return (
    <>
      <div className="space-y-1.5 text-sm" data-slot="add-url">
        {urls.ssh && urls.https ? (
          <RadioGroup
            aria-label="Clone with"
            value={props.protocol}
            onValueChange={(value) => props.onProtocolChange(value as CloneProtocol)}
            className="flex-row flex-wrap"
          >
            <label className="flex cursor-pointer items-center gap-2">
              <Radio value="ssh" disabled={props.disabled} />
              Clone over SSH
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <Radio value="https" disabled={props.disabled} />
              HTTPS
            </label>
          </RadioGroup>
        ) : (
          <p className="font-medium">Clone from</p>
        )}
        <p className="wrap-anywhere font-mono text-muted-foreground text-xs">{props.remoteUrl}</p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={folderId}>Folder on {destName}</Label>
        <Input
          id={folderId}
          value={props.folder}
          autoComplete="off"
          spellCheck={false}
          disabled={props.disabled}
          onChange={(event) => props.onFolderChange(event.target.value)}
        />
        {props.inspectionError && (
          <p role="alert" className="wrap-anywhere text-destructive-foreground text-xs">
            {props.inspectionError}
          </p>
        )}
        {plan?.kind === "refuse" && (
          <div className="flex flex-wrap items-center gap-2 text-xs" data-slot="add-refuse">
            <p role="alert" className="text-destructive-foreground">
              {plan.reason}
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={props.disabled}
              onClick={() => props.onFolderChange(plan.suggestion)}
            >
              Use {plan.suggestion}
            </Button>
          </div>
        )}
        {plan?.kind === "consolidate" && (
          <p className="text-muted-foreground text-xs" data-slot="add-consolidate">
            {props.linkSupported
              ? `That folder is already a checkout of this repository. Link and consolidate brings your changes from ${props.sourceName} into it, shows you a preview first, and can be undone.`
              : `That folder is already a checkout of this repository, but linking needs a newer SpecWithCode on both machines.`}
          </p>
        )}
      </div>

      <div className="space-y-1 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={props.copyIgnored}
            disabled={props.disabled || props.scan.state === "failed"}
            onCheckedChange={(checked) => props.onCopyIgnoredChange(checked === true)}
          />
          Copy ignored files
        </label>
        <p className="ps-6 text-muted-foreground text-xs">{IGNORED_FILES_NOTE}</p>
      </div>

      {props.scan.state === "scanning" && (
        <p role="status" className="text-muted-foreground text-xs">
          Looking for secret files on {props.sourceName}…
        </p>
      )}
      {props.scan.state === "failed" && (
        <p role="alert" className="wrap-anywhere text-destructive-foreground text-xs">
          {props.scan.message} Cloning still works; only extra files can't be copied.
        </p>
      )}
    </>
  );
}
