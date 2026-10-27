/**
 * The first thing an empty design system shows on Overview: four ways to
 * fill it. Importing reads a repository and reviews the result, uploading
 * stores brand files (images in assets/, fonts in fonts/, Markdown as
 * guidance in docs/), starting from the basics adds neutral starter sets
 * from one accent and one family, and describing it hands the work to an
 * agent.
 */
import type { DesignOwnerInput, DesignSystemId, EnvironmentId } from "@specweave-studio/contracts";
import {
  FolderGit2Icon,
  LayersIcon,
  MessageSquareTextIcon,
  UploadIcon,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import { hasFiles } from "./AssetSetCard";
import { extensionOf } from "./filesModel";
import { ACCEPT_ATTRIBUTE, FONT_EXTENSIONS, planUploads } from "./storedPaths";
import { AccentPicker, accentProblem, FamilyPicker } from "./StarterOffer";
import { DEFAULT_ACCENT, DEFAULT_FAMILY, type StarterOptions } from "./starterSets";
import { SystemImportDialog } from "./SystemImportDialog";
import {
  uploadAll,
  uploadFailureText,
  useSystemFilesApi,
  useSystemName,
  type SystemFilesApi,
} from "./systemFilesApi";

export interface WelcomeSheetProps {
  readonly environmentId: EnvironmentId;
  readonly owner: DesignOwnerInput;
  readonly systemId: DesignSystemId;
  readonly canEdit: boolean;
  /** After a repository import is confirmed into this system, or brand files are stored. */
  readonly onChanged?: () => void;
  /** Adds every starter set; absent where the page cannot edit tokens. */
  readonly onStart?: (options: StarterOptions) => void;
}

/** "Not sure where to start?" for a system with no tokens yet. */
export function WelcomeSheet(props: WelcomeSheetProps) {
  const api = useSystemFilesApi(props);
  const systemName = useSystemName(props);
  const [importing, setImporting] = useState(false);
  return (
    <>
      <WelcomeSheetView
        canEdit={props.canEdit}
        systemName={systemName}
        api={api}
        onImport={() => setImporting(true)}
        onChanged={props.onChanged}
        onStart={props.onStart}
      />
      {importing ? (
        <SystemImportDialog
          environmentId={props.environmentId}
          owner={props.owner}
          systemId={props.systemId}
          onImported={() => props.onChanged?.()}
          onClose={() => setImporting(false)}
        />
      ) : null}
    </>
  );
}

/** Where a brand file goes: fonts to fonts/, Markdown to docs/, everything else to assets/Brand. */
export function brandFolder(name: string): string {
  const extension = extensionOf(name);
  if (FONT_EXTENSIONS.has(extension)) return "fonts";
  if (extension === "md") return "docs";
  return "assets/Brand";
}

/** "Added 3 files: 2 to Assets, 1 to Typography." */
export function brandSummary(paths: readonly string[]): string {
  const counts = [
    [paths.filter((path) => path.startsWith("assets/")).length, "Assets"],
    [paths.filter((path) => path.startsWith("fonts/")).length, "Typography"],
    [paths.filter((path) => path.startsWith("docs/")).length, "Overview"],
  ] as const;
  const parts = counts
    .filter(([count]) => count > 0)
    .map(([count, place]) => `${count} to ${place}`);
  return `Added ${paths.length} ${paths.length === 1 ? "file" : "files"}: ${parts.join(", ")}.`;
}

function Option({
  icon: Icon,
  title,
  description,
  busy,
  onClick,
  children,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  busy?: boolean;
  onClick: () => void;
  children?: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={busy}
      className="group flex min-w-0 flex-col items-start gap-1.5 rounded-lg border border-border/70 bg-card px-4 py-3 text-left outline-none transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-(--disabled-opacity)"
      onClick={onClick}
    >
      <Icon aria-hidden className="size-4.5 text-muted-foreground group-hover:text-foreground" />
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
      {children}
    </button>
  );
}

export function WelcomeSheetView({
  canEdit,
  systemName,
  api,
  onImport,
  onChanged,
  onStart,
}: {
  canEdit: boolean;
  systemName: string;
  api: Pick<SystemFilesApi, "put" | "listing">;
  onImport: () => void;
  onChanged?: (() => void) | undefined;
  onStart?: ((options: StarterOptions) => void) | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [describing, setDescribing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [family, setFamily] = useState(DEFAULT_FAMILY);
  const canStart = canEdit && onStart !== undefined;
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  const [dropping, setDropping] = useState(false);
  const listing = api.listing.data;

  const upload = async (files: File[]) => {
    const taken = new Set(
      (listing?.files ?? []).filter((file) => file.origin === "stored").map((file) => file.path),
    );
    const plan = planUploads(
      files,
      (file) => brandFolder(file.name),
      taken,
      listing === null
        ? null
        : {
            usedBytes: listing.usedBytes,
            limitBytes: listing.limitBytes,
            fileCount: taken.size,
            limitFiles: listing.limitFiles,
          },
    );
    if (!plan.ok) return setMessage({ text: plan.message, problem: true });
    setMessage(null);
    const report = await uploadAll(api, plan.uploads, (done, total) =>
      setProgress(`Adding ${Math.min(done + 1, total)} of ${total}…`),
    );
    setProgress(null);
    if (report.saved.length > 0) {
      api.listing.refresh();
      onChanged?.();
    }
    const failure = uploadFailureText(report);
    setMessage(
      failure !== null
        ? { text: failure, problem: true }
        : { text: brandSummary(report.saved.map((file) => file.path)), problem: false },
    );
  };

  const prompt = `Fill in the ${systemName || "new"} design system: calm, high contrast, one blue accent, light and dark modes.`;

  return (
    <section
      aria-labelledby="welcome-sheet-title"
      data-testid="welcome-sheet"
      className={cn(
        "flex flex-col gap-4 rounded-xl border border-border/70 bg-muted/20 p-4 sm:p-5",
        dropping && "border-ring bg-accent/40",
      )}
      onDragOver={(event) => {
        if (!canEdit || progress !== null || !hasFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        if (!canEdit || progress !== null) return;
        event.preventDefault();
        setDropping(false);
        void upload([...event.dataTransfer.files]);
      }}
    >
      <div className="report-document flex flex-col gap-1">
        <h2 id="welcome-sheet-title" className="report-document-serif text-xl text-foreground">
          Not sure where to start?
        </h2>
        <p className="text-sm text-muted-foreground">
          {canEdit
            ? "This design system is empty. Fill it from code, from your brand files, or with an agent."
            : "This design system is empty. Someone who can edit it can fill it from code, brand files or an agent."}
        </p>
      </div>
      <div
        className={cn("grid gap-3 sm:grid-cols-2", canStart ? "xl:grid-cols-4" : "lg:grid-cols-3")}
      >
        {canEdit ? (
          <>
            <Option
              testId="welcome-import"
              icon={FolderGit2Icon}
              title="Import from a repository"
              description="Read token files and components from a project's code. You review everything before it's saved."
              onClick={onImport}
            />
            <Option
              testId="welcome-upload"
              icon={UploadIcon}
              title="Upload brand files"
              description="Logos, images, fonts and guidelines. Images go to Assets, fonts to Typography, Markdown to Overview."
              busy={progress !== null}
              onClick={() => input.current?.click()}
            />
          </>
        ) : null}
        {canStart ? (
          <Option
            testId="welcome-start"
            icon={LayersIcon}
            title="Start from the basics"
            description="A palette from your accent, a type scale, spacing, radii and shadows. Change any of it after."
            onClick={() => setStarting((open) => !open)}
          />
        ) : null}
        <Option
          testId="welcome-describe"
          icon={MessageSquareTextIcon}
          title="Describe it"
          description="Tell an agent the look you want; it proposes tokens for you to review."
          onClick={() => setDescribing((open) => !open)}
        />
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="welcome-upload-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) void upload(files);
        }}
      />
      {canEdit ? (
        <p className="text-xs text-muted-foreground">Or drop files anywhere on this card.</p>
      ) : null}
      {progress ? (
        <p className="text-xs text-muted-foreground" role="status">
          {progress}
        </p>
      ) : null}
      {message ? (
        <p
          role={message.problem ? "alert" : "status"}
          data-testid="welcome-message"
          className={
            message.problem ? "text-sm text-destructive-foreground" : "text-sm text-foreground"
          }
        >
          {message.text}
        </p>
      ) : null}
      {starting && canStart ? (
        <div
          className="grid gap-4 rounded-lg border border-border/70 bg-background px-4 py-4 sm:grid-cols-2"
          data-testid="welcome-start-panel"
        >
          <AccentPicker value={accent} onChange={setAccent} />
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">Font family</span>
            <FamilyPicker value={family} onChange={setFamily} />
          </div>
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <p className="text-muted-foreground text-xs">
              Adds about 40 tokens in one step; Undo removes them all.
            </p>
            <Button
              size="sm"
              data-testid="welcome-start-add"
              disabled={accentProblem(accent) !== null}
              onClick={() => {
                setStarting(false);
                onStart?.({ accent, family });
              }}
            >
              Add the basics
            </Button>
          </div>
        </div>
      ) : null}
      {describing ? (
        <div
          className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background px-4 py-3 text-sm"
          data-testid="welcome-describe-panel"
        >
          <p className="text-foreground">Ask an agent in any thread, for example: “{prompt}”</p>
          <p className="text-muted-foreground">
            Agents use the <code className="font-mono text-xs">design_system_propose</code> tool.
            Their proposal waits under Pending proposals in Settings &gt; Design systems, and
            nothing is saved until you review and confirm it.
          </p>
        </div>
      ) : null}
    </section>
  );
}
