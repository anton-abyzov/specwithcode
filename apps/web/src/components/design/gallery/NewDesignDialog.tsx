import type {
  DesignKind,
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
  ProjectId,
} from "@specweave-studio/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import type { CopyOptions, CopyOutcome } from "../systems/DesignSystemPicker";
import { UnavailableOwner } from "../systems/NewDesignSystemDialog";
import { CreationSystemPicker } from "./CreationSystemPicker";
import {
  effectiveChoice,
  resolveChoice,
  systemOptions,
  type ScanState,
  type SystemChoice,
} from "./creationSystem";
import { deckTitleFromFile, PPTX_ACCEPT, pptxFileProblem } from "./deckImport";
import type { GalleryProject } from "./DesignActions";
import type { FoundSystem } from "./foundSystems";

const PLAYGROUND = "__playground__";

export interface NewDesignRequest {
  readonly kind: DesignKind;
  readonly owner: DesignOwnerInput;
  readonly title: string;
  readonly designSystem: DesignSystemId | null;
  /** The system's name when the dialog knows it. */
  readonly designSystemName?: string | null;
  /** A system found in the project's repository, reused without importing it. */
  readonly found?: FoundSystem | null;
}

const COPY = {
  design: {
    title: "New design",
    untitled: "Untitled design",
    create: "Create design",
    where:
      "A Playground design stays on this machine. A project's design is saved in its folder and travels with the repository.",
  },
  slides: {
    title: "New slides",
    untitled: "Untitled slides",
    create: "Create slides",
    where:
      "Slides are 1920 by 1080 and take their colors and fonts from the design system. Playground slides stay on this machine; a project's slides travel with the repository.",
  },
} as const;

/** A blank design or deck in the Playground or a project the user picks. */
export function NewDesignDialog({
  kind = "design",
  open,
  onOpenChange,
  projects,
  systems,
  onCreate,
  onCopySystem = null,
  initialOwner,
  initialSystemId = null,
  systemsReady = true,
  scanFor = () => null,
  onScan = null,
  unavailable = null,
  onImport = null,
  initialFile = null,
}: {
  kind?: DesignKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly GalleryProject[];
  systems: readonly DesignSystemSummary[];
  /** Resolves to an error message, or null once the design exists. */
  onCreate: (request: NewDesignRequest) => Promise<string | null>;
  /** Copies another owner's system into the new design's owner, when the person presses Create. */
  onCopySystem?:
    | ((
        system: DesignSystemSummary,
        to: DesignOwnerInput,
        options?: CopyOptions,
      ) => Promise<CopyOutcome>)
    | null;
  /** Preselected "Save in"; the Playground when omitted. */
  initialOwner?: DesignOwnerInput;
  /** Preselected design system, for "Use in a new design". */
  initialSystemId?: DesignSystemId | null;
  /** Whether `systems` has loaded; a project is scanned only once its own systems are known. */
  systemsReady?: boolean;
  /** A code project's repository scan, if one ran. */
  scanFor?: (projectId: ProjectId) => ScanState | null;
  /** Asks for that scan; `again` repeats a finished one. */
  onScan?: ((projectId: ProjectId, again?: boolean) => void) | null;
  /**
   * The preselected project when it is not a place for a new design (archived,
   * automated): shown as the current context, never offered; Create waits for a choice.
   */
  unavailable?: { readonly id: ProjectId; readonly title: string; readonly reason: string } | null;
  /**
   * Slides only: imports a PowerPoint file into the chosen owner and system
   * ("Import PowerPoint…"); resolves to an error message, or null once the
   * deck exists. Absent when the server cannot import decks.
   */
  onImport?: ((request: NewDesignRequest, file: File) => Promise<string | null>) | null;
  /** A file already picked from "Make something new", so the dialog opens ready to import. */
  initialFile?: File | null;
}) {
  const id = useId();
  const [where, setWhere] = useState<string>(
    initialOwner?.kind === "project" ? initialOwner.projectId : PLAYGROUND,
  );
  const [title, setTitle] = useState("");
  const [choice, setChoice] = useState<SystemChoice | null>(
    initialSystemId === null ? null : { kind: "own", systemId: initialSystemId },
  );
  const [copied] = useState(
    () => new Map<string, { readonly systemId: DesignSystemId; readonly name: string }>(),
  );
  const canImport = kind === "slides" && onImport !== null;
  const [file, setFile] = useState<File | null>(canImport ? initialFile : null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importing = canImport && file !== null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    importing ? pptxFileProblem(file) : null,
  );
  const owner: DesignOwnerInput =
    where === PLAYGROUND
      ? { kind: "playground" }
      : { kind: "project", projectId: where as ProjectId };
  const project = projects.find((candidate) => candidate.id === where) ?? null;
  const copy = COPY[kind];
  // Only a code project has a repository to scan.
  const blocked = unavailable !== null && where === unavailable.id;
  const scannable = project !== null && project.kind !== "personal";
  const scan = scannable ? scanFor(project.id) : null;
  const options = systemOptions({
    systems,
    owner: blocked ? null : owner,
    scan,
    canCopy: onCopySystem !== null,
  });
  const value = effectiveChoice(choice, options);
  const hasOwn = options.own.length > 0;
  const scanProject = scannable && onScan !== null && systemsReady && !hasOwn ? project.id : null;

  useEffect(() => {
    if (open && scanProject !== null) onScan?.(scanProject);
  }, [onScan, open, scanProject]);

  const submit = async () => {
    if (busy || blocked) return;
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
    const request: NewDesignRequest | null = resolved.ok
      ? {
          kind,
          owner,
          title: title.trim() || (importing ? deckTitleFromFile(file.name) : copy.untitled),
          designSystem: resolved.designSystem,
          designSystemName: resolved.name,
          found: resolved.found,
        }
      : null;
    const problem = !resolved.ok
      ? resolved.message
      : importing
        ? (pptxFileProblem(file) ?? (await onImport!(request!, file)))
        : await onCreate(request!);
    setBusy(false);
    setError(problem);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="sm:max-w-md" data-testid="new-design-dialog" data-kind={kind}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{importing ? "Import PowerPoint" : copy.title}</DialogTitle>
            <DialogDescription>
              {importing
                ? "Text, simple shapes, pictures and speaker notes become editable slides. Anything the import cannot keep is listed for each slide."
                : copy.where}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-title`}>Title</Label>
                <Input
                  id={`${id}-title`}
                  value={title}
                  maxLength={180}
                  placeholder={importing ? deckTitleFromFile(file.name) : copy.untitled}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-where`}>Save in</Label>
                <Select
                  value={where}
                  onValueChange={(value) => {
                    setWhere(value ?? PLAYGROUND);
                    setChoice(null);
                  }}
                >
                  <SelectTrigger id={`${id}-where`} size="sm" data-testid="new-design-where">
                    <SelectValue>
                      {blocked ? (
                        <UnavailableOwner title={unavailable.title} reason={unavailable.reason} />
                      ) : (
                        (project?.title ?? "Playground")
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {unavailable !== null ? (
                      <SelectItem
                        value={unavailable.id}
                        disabled
                        data-testid="new-design-where-unavailable"
                      >
                        <UnavailableOwner title={unavailable.title} reason={unavailable.reason} />
                      </SelectItem>
                    ) : null}
                    <SelectItem value={PLAYGROUND}>Playground</SelectItem>
                    {projects.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {blocked ? (
                  <p className="text-muted-foreground text-xs" data-testid="new-design-where-hint">
                    Choose where to save it: the Playground or one of your projects.
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
                  scan={scannable && !hasOwn ? scan : null}
                  onScanAgain={
                    onScan === null || !scannable ? null : () => onScan(project.id, true)
                  }
                  projectTitle={project?.title ?? null}
                  ownerLabel={project?.title ?? "Playground"}
                  verb="create"
                  disabled={busy}
                />
              </div>
              {importing ? (
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate" data-testid="import-pptx-file">
                    {file.name}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setFile(null);
                      setError(null);
                    }}
                  >
                    Start blank instead
                  </Button>
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="text-destructive-foreground text-sm">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            {canImport ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept={PPTX_ACCEPT}
                  hidden
                  data-testid="import-pptx-input"
                  onChange={(event) => {
                    const picked = event.target.files?.[0] ?? null;
                    event.target.value = "";
                    if (picked === null) return;
                    setFile(picked);
                    setError(pptxFileProblem(picked));
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="sm:me-auto"
                  disabled={busy}
                  data-testid="import-pptx"
                  onClick={() => fileInput.current?.click()}
                >
                  {importing ? "Choose another file…" : "Import PowerPoint…"}
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || blocked} data-testid="new-design-create">
              {importing ? (busy ? "Importing…" : "Import") : busy ? "Creating…" : copy.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
