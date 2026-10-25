import type {
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
  ProjectId,
} from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useId, useState } from "react";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "~/hooks/useLocalStorage";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { CreationSystemPicker } from "./gallery/CreationSystemPicker";
import {
  effectiveChoice,
  resolveChoice,
  systemOptions,
  type ScanState,
  type SystemChoice,
} from "./gallery/creationSystem";
import type { GalleryProject } from "./gallery/DesignActions";
import type { FoundSystem } from "./gallery/foundSystems";
import type { CopyOptions, CopyOutcome } from "./systems/DesignSystemPicker";
import { UnavailableOwner } from "./systems/NewDesignSystemDialog";

export interface DesignFromCodeRequest {
  readonly projectId: ProjectId;
  readonly designSystem: DesignSystemId | null;
  /** The system's name when the dialog knows it (a copy made at Start is not listed yet). */
  readonly designSystemName?: string | null;
  /** A system found in the repository, reused without importing it. */
  readonly found?: FoundSystem | null;
  readonly brief: string;
}

/** The brief's length cap, in the field and in its saved draft. */
export const BRIEF_DRAFT_LIMIT = 4000;
/** How many projects keep a saved brief; the least recently edited go first. */
export const BRIEF_DRAFTS_KEPT = 20;
const BRIEF_DRAFT_PREFIX = "studio:design-from-code-brief:";
const briefDraftKey = (projectId: ProjectId) => `${BRIEF_DRAFT_PREFIX}${projectId}`;
/** The projects with a saved brief, most recently edited first. */
const BRIEF_DRAFT_ORDER_KEY = "studio:design-from-code-brief-order";
const DraftOrder = Schema.Array(Schema.String);

const readDraftOrder = (): string[] => {
  try {
    return [...(getLocalStorageItem(BRIEF_DRAFT_ORDER_KEY, DraftOrder) ?? [])];
  } catch {
    return [];
  }
};

/** Projects whose brief was saved before the order was kept, so they count as the oldest. */
function unlistedDrafts(listed: readonly string[]): string[] {
  if (typeof window === "undefined") return [];
  const found: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === null || !key.startsWith(BRIEF_DRAFT_PREFIX)) continue;
    const projectId = key.slice(BRIEF_DRAFT_PREFIX.length);
    if (!listed.includes(projectId)) found.push(projectId);
  }
  return found;
}

/**
 * Moves a project to the front of the saved briefs, or out of them, and drops
 * the briefs past {@link BRIEF_DRAFTS_KEPT}, so drafts of deleted projects do
 * not pile up.
 */
function recordDraft(projectId: ProjectId, saved: boolean): void {
  const order = readDraftOrder();
  if (!saved) {
    if (order.includes(projectId))
      setLocalStorageItem(
        BRIEF_DRAFT_ORDER_KEY,
        order.filter((entry) => entry !== projectId),
        DraftOrder,
      );
    return;
  }
  if (order[0] === projectId) return;
  const front = [projectId, ...order.filter((entry) => entry !== projectId)];
  const all = [...front, ...unlistedDrafts(front)];
  for (const dropped of all.slice(BRIEF_DRAFTS_KEPT))
    removeLocalStorageItem(briefDraftKey(dropped as ProjectId));
  setLocalStorageItem(BRIEF_DRAFT_ORDER_KEY, all.slice(0, BRIEF_DRAFTS_KEPT), DraftOrder);
}

/** The brief saved for a project, or null when there is none. */
export function readBriefDraft(projectId: ProjectId): string | null {
  try {
    return getLocalStorageItem(briefDraftKey(projectId), Schema.String);
  } catch {
    return null;
  }
}

/**
 * Keeps a project's brief across closing the dialog, a reload or a trip to
 * Settings > Providers; an empty brief removes the draft. Only the
 * {@link BRIEF_DRAFTS_KEPT} most recently edited projects keep one.
 */
export function writeBriefDraft(projectId: ProjectId, brief: string): void {
  try {
    const text = brief.slice(0, BRIEF_DRAFT_LIMIT);
    const saved = text.trim() !== "";
    if (saved) setLocalStorageItem(briefDraftKey(projectId), text, Schema.String);
    else removeLocalStorageItem(briefDraftKey(projectId));
    recordDraft(projectId, saved);
  } catch {
    // Storage is full or blocked: the brief stays in the open dialog only.
  }
}

const canAlwaysWait = () => true;

/**
 * Starts a design that an agent builds against a project's real code: it
 * asks for the project and an optional design system, then the page creates
 * the design in that project and starts a thread there bound to it. Without a
 * ready provider the thread is created with the brief waiting in its
 * composer, and runs once the person signs in and sends it. A project without
 * a design system of its own is scanned (read-only) for one.
 */
export function DesignFromCodeDialog({
  open,
  onOpenChange,
  projects,
  systems,
  systemsReady = true,
  initialProjectId = null,
  workerLabelFor,
  canWaitFor = canAlwaysWait,
  onStart,
  hasCreated = () => false,
  onOpenCreated = null,
  onCopySystem = null,
  scanFor = () => null,
  onScan = null,
  unavailable = null,
  connected = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly GalleryProject[];
  systems: readonly DesignSystemSummary[];
  /** Whether `systems` has loaded; a project is scanned only once its own systems are known. */
  systemsReady?: boolean;
  initialProjectId?: ProjectId | null;
  /** The model the project's new threads start on, or null when no provider is ready. */
  workerLabelFor: (projectId: ProjectId) => string | null;
  /**
   * Whether the project's thread can be created to wait for a provider when
   * none is ready; false when this machine reports no provider at all, and
   * then the dialog refuses.
   */
  canWaitFor?: (projectId: ProjectId) => boolean;
  /**
   * Resolves to an error message, or null once the design and its thread
   * exist; without a ready provider the thread waits with the brief.
   */
  onStart: (request: DesignFromCodeRequest) => Promise<string | null>;
  /** Whether an earlier attempt created a design in the project whose thread did not start. */
  hasCreated?: (projectId: ProjectId) => boolean;
  /** Opens that design. */
  onOpenCreated?: ((projectId: ProjectId) => void) | null;
  /** Copies another owner's system into the project, when the person presses Start design. */
  onCopySystem?:
    | ((
        system: DesignSystemSummary,
        to: DesignOwnerInput,
        options?: CopyOptions,
      ) => Promise<CopyOutcome>)
    | null;
  /** The project's repository scan, if one ran. */
  scanFor?: (projectId: ProjectId) => ScanState | null;
  /** Asks for that scan; `again` repeats a finished one. */
  onScan?: ((projectId: ProjectId, again?: boolean) => void) | null;
  /**
   * The preselected project when it is not one to design from (archived, automated, not
   * a code project): shown as the current context, never offered; Start waits for a choice.
   */
  unavailable?: { readonly id: ProjectId; readonly title: string; readonly reason: string } | null;
  /**
   * Whether this machine's connection is up. The dialog can open from cached
   * state before it is, and a start then would be refused unsent.
   */
  connected?: boolean;
}) {
  const id = useId();
  const [projectId, setProjectId] = useState<ProjectId | null>(
    initialProjectId ?? (projects.length === 1 ? projects[0]!.id : null),
  );
  const [choice, setChoice] = useState<SystemChoice | null>(null);
  const [brief, setBriefText] = useState(() =>
    projectId === null ? "" : (readBriefDraft(projectId) ?? ""),
  );
  // Only an edit saves a draft, and only for the project selected while it is made.
  const setBrief = (text: string) => {
    setBriefText(text);
    if (projectId !== null) writeBriefDraft(projectId, text);
  };
  // Another project shows its own draft; one without a draft keeps the text on screen,
  // unsaved, so glancing at a project never gives it another project's brief.
  const switchProject = (next: ProjectId | null) => {
    setProjectId(next);
    if (next === null) return;
    const saved = readBriefDraft(next);
    if (saved !== null) setBriefText(saved);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Copies made at an earlier Start, so a retry uses them instead of copying again.
  const [copied] = useState(
    () => new Map<string, { readonly systemId: DesignSystemId; readonly name: string }>(),
  );
  // A project the dialog does not offer (see `unavailable`) is never found here, so it is never used.
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const blocked = unavailable !== null && projectId === unavailable.id;
  const owner: DesignOwnerInput | null =
    project === null ? null : { kind: "project", projectId: project.id };
  const scan = project === null ? null : scanFor(project.id);
  const options = systemOptions({ systems, owner, scan, canCopy: onCopySystem !== null });
  const value = effectiveChoice(choice, options);
  const worker = projectId === null ? null : workerLabelFor(projectId);
  // No provider at all: nothing to record on the thread, so nothing is created.
  const refused = projectId !== null && worker === null && !canWaitFor(projectId);
  const ready = project !== null && connected && !busy && !refused;
  const action = worker === null ? "Create design" : "Start design";
  const hasOwn = options.own.length > 0;

  const scanProject = project !== null && onScan !== null && systemsReady && !hasOwn;
  useEffect(() => {
    if (open && scanProject && projectId !== null) onScan?.(projectId);
  }, [onScan, open, projectId, scanProject]);

  const submit = async () => {
    if (!ready || projectId === null || owner === null) return;
    setBusy(true);
    setError(null);
    const resolved = await resolveChoice({
      choice: value,
      options,
      owner,
      copy:
        onCopySystem === null
          ? null
          : (system, copyOptions) => onCopySystem(system, owner, copyOptions),
      copied,
    });
    const problem = resolved.ok
      ? await onStart({
          projectId,
          designSystem: resolved.designSystem,
          designSystemName: resolved.name,
          found: resolved.found,
          brief: brief.trim(),
        })
      : resolved.message;
    setBusy(false);
    setError(problem);
    // The thread has the brief now (sent, or waiting in its composer); a failure keeps the draft.
    if (problem === null) writeBriefDraft(projectId, "");
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="sm:max-w-lg" data-testid="design-from-code-dialog">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Design from code</DialogTitle>
            <DialogDescription>
              An agent reads the project's code and designs on a new canvas there. Watch, comment
              and edit while it works.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-project`}>Project</Label>
                {projects.length === 0 && !blocked ? (
                  <p className="text-muted-foreground text-sm">
                    Add a code project first. The design is saved in its folder.
                  </p>
                ) : (
                  <Select
                    value={projectId}
                    onValueChange={(next) => {
                      switchProject(next as ProjectId | null);
                      setChoice(null);
                      setError(null);
                    }}
                  >
                    <SelectTrigger
                      id={`${id}-project`}
                      size="sm"
                      data-testid="design-from-code-project"
                    >
                      <SelectValue>
                        {blocked ? (
                          <UnavailableOwner title={unavailable.title} reason={unavailable.reason} />
                        ) : (
                          (project?.title ?? (
                            <span className="text-muted-foreground">Choose a project…</span>
                          ))
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {unavailable !== null ? (
                        <SelectItem
                          value={unavailable.id}
                          disabled
                          data-testid="design-from-code-project-unavailable"
                        >
                          <UnavailableOwner title={unavailable.title} reason={unavailable.reason} />
                        </SelectItem>
                      ) : null}
                      {projects.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
                {blocked ? (
                  <p
                    className="text-muted-foreground text-xs"
                    data-testid="design-from-code-project-hint"
                  >
                    Choose one of your code projects to design from.
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-system`}>Design system</Label>
                <CreationSystemPicker
                  id={`${id}-system`}
                  options={options}
                  value={value}
                  onChange={setChoice}
                  scan={hasOwn ? null : scan}
                  onScanAgain={
                    onScan === null || project === null ? null : () => onScan(project.id, true)
                  }
                  projectTitle={project?.title ?? null}
                  ownerLabel={project?.title ?? "the project"}
                  verb="start"
                  disabled={project === null || busy}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-brief`}>What should this design show?</Label>
                <Textarea
                  id={`${id}-brief`}
                  rows={4}
                  maxLength={BRIEF_DRAFT_LIMIT}
                  value={brief}
                  placeholder="A settings page for notifications, in the style of the existing app"
                  onChange={(event) => setBrief(event.target.value)}
                />
              </div>
              {connected ? null : (
                <p
                  role="status"
                  className="text-muted-foreground text-xs"
                  data-testid="design-from-code-connecting"
                >
                  Connecting to this machine. {action} turns on once it is connected.
                </p>
              )}
              {error ? (
                <div className="flex items-start justify-between gap-3">
                  <p role="alert" className="text-destructive-foreground text-sm">
                    {error}
                  </p>
                  {onOpenCreated !== null && projectId !== null && hasCreated(projectId) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={busy}
                      onClick={() => onOpenCreated(projectId)}
                      data-testid="design-from-code-open"
                    >
                      Open design
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter className="sm:items-center">
            {project !== null ? (
              <p
                className="min-w-0 text-muted-foreground text-xs sm:me-auto"
                data-testid="design-from-code-worker"
              >
                {refused ? (
                  <>
                    This machine reports no provider, so the design cannot start. Add one in{" "}
                    <Link
                      to="/settings/providers"
                      className="text-foreground underline underline-offset-2 hover:text-primary"
                      data-testid="design-from-code-providers-link"
                      onClick={() => onOpenChange(false)}
                    >
                      Settings &gt; Providers
                    </Link>
                    .
                  </>
                ) : worker === null ? (
                  <>
                    No provider is ready on this machine. Create design makes the design and its
                    thread now, with your brief waiting to send. To run it, sign in to one in{" "}
                    <Link
                      to="/settings/providers"
                      className="text-foreground underline underline-offset-2 hover:text-primary"
                      data-testid="design-from-code-providers-link"
                      onClick={() => onOpenChange(false)}
                    >
                      Settings &gt; Providers
                    </Link>
                    .
                  </>
                ) : (
                  `Starts a thread in ${project.title} on ${worker}.`
                )}
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ready} data-testid="design-from-code-start">
              {busy ? (worker === null ? "Creating…" : "Starting…") : action}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
