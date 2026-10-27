/**
 * Font files under Typography: "Upload font" stores woff, woff2, ttf and otf
 * files in fonts/, and the list after the type tables shows every font the
 * system keeps or was read from. Files manages them further (move, remove).
 */
import type { DesignSystemFile } from "@specweave-studio/contracts";
import { UploadIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import { extensionOf, fileName, formatSize } from "./filesModel";
import { FONT_EXTENSIONS, planUploads } from "./storedPaths";
import {
  uploadAll,
  uploadFailureText,
  useSystemFilesApi,
  type SystemAddress,
  type SystemFilesApi,
} from "./systemFilesApi";
import { INSET } from "./tokenRows";

const FONT_ACCEPT = [...FONT_EXTENSIONS].map((extension) => `.${extension}`).join(",");

/** Font files the system keeps or was read from, by path. */
export function fontFiles(files: readonly DesignSystemFile[]): DesignSystemFile[] {
  return files
    .filter((file) => FONT_EXTENSIONS.has(extensionOf(file.path)))
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

export interface FontUploads {
  readonly canEdit: boolean;
  /** Null until the system's files are listed; uploads wait for that list. */
  readonly fonts: readonly DesignSystemFile[] | null;
  /** Why the list is missing, when listing failed; editors only, since viewers cannot upload. */
  readonly unavailable: string | null;
  readonly progress: string | null;
  readonly message: {
    readonly text: string;
    readonly problem: boolean;
    /** Says the list has not loaded; it goes once the list does. */
    readonly waiting?: boolean;
  } | null;
  /** Opens the file picker. */
  readonly pick: () => void;
  /** The hidden file input; render it once. */
  readonly input: ReactNode;
}

/** One upload queue for the page, shared by the header button and the list. */
export function useFontUploads(
  address: SystemAddress & { readonly canEdit: boolean; readonly onChanged?: () => void },
): FontUploads {
  const api = useSystemFilesApi(address);
  return useFontUploadState(api, address.canEdit, address.onChanged);
}

export function useFontUploadState(
  api: Pick<SystemFilesApi, "put" | "listing">,
  canEdit: boolean,
  onChanged?: () => void,
): FontUploads {
  const ref = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<FontUploads["message"]>(null);
  const listing = api.listing.data;
  const notListed = {
    text:
      api.listing.error === null
        ? "The font list hasn't loaded yet, so nothing was uploaded. Try again in a moment."
        : `${api.listing.error} Nothing was uploaded.`,
    problem: true,
  };
  useEffect(() => {
    if (listing !== null) setMessage((current) => (current?.waiting === true ? null : current));
  }, [listing]);

  const upload = async (files: File[]) => {
    const notFont = files.find((file) => !FONT_EXTENSIONS.has(extensionOf(file.name)));
    if (notFont !== undefined)
      return setMessage({
        text: `${notFont.name} is not a font file. Use woff2, woff, ttf or otf.`,
        problem: true,
      });
    // Without the list, a font of the same name would be replaced and the limits unchecked.
    if (listing === null) return setMessage(notListed);
    const stored = listing.files.filter((file) => file.origin === "stored");
    const plan = planUploads(files, () => "fonts", new Set(stored.map((file) => file.path)), {
      usedBytes: listing.usedBytes,
      limitBytes: listing.limitBytes,
      fileCount: stored.length,
      limitFiles: listing.limitFiles,
    });
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
        : {
            text:
              report.saved.length === 1
                ? `Added ${fileName(report.saved[0]!.path)} to fonts/.`
                : `Added ${report.saved.length} fonts to fonts/.`,
            problem: false,
          },
    );
  };

  return {
    canEdit,
    fonts: listing === null ? null : fontFiles(listing.files),
    unavailable: canEdit && listing === null ? api.listing.error : null,
    progress,
    message,
    pick: () =>
      listing === null ? setMessage({ ...notListed, waiting: true }) : ref.current?.click(),
    input: canEdit ? (
      <input
        ref={ref}
        type="file"
        multiple
        accept={FONT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="font-upload-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) void upload(files);
        }}
      />
    ) : null,
  };
}

export function UploadFontButton({
  fonts,
  variant = "outline",
  onPick,
}: {
  fonts: FontUploads;
  variant?: "outline" | "ghost";
  /** Runs before the picker opens, such as opening the section the results show in. */
  onPick?: () => void;
}) {
  if (!fonts.canEdit) return null;
  // Waiting for the list, the button stays reachable: pressing it says why nothing opens.
  const waiting = fonts.fonts === null;
  return (
    <Button
      variant={variant}
      size="xs"
      disabled={fonts.progress !== null}
      aria-disabled={waiting || undefined}
      title={waiting ? (fonts.unavailable ?? "Loading the font list…") : undefined}
      className={waiting ? "opacity-(--disabled-opacity)" : undefined}
      data-testid="font-upload"
      onClick={() => {
        onPick?.();
        fonts.pick();
      }}
    >
      <UploadIcon aria-hidden />
      Upload font
    </Button>
  );
}

/** "Font files": what is stored, or "No font files yet". */
export function FontFilesList({ fonts }: { fonts: FontUploads }) {
  const list = fonts.fonts;
  return (
    <div className="flex flex-col pt-4" data-testid="font-files">
      <div className={cn("flex min-h-8 items-center gap-2 pb-2.5", INSET)}>
        <h3 className="font-medium text-sm text-foreground">Font files</h3>
        {list !== null && list.length > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">{list.length}</span>
        ) : null}
        <span className="ml-auto">
          <UploadFontButton fonts={fonts} variant="ghost" />
        </span>
      </div>
      {list === null ? (
        fonts.unavailable !== null ? (
          <p role="alert" className={cn("pb-2 text-destructive-foreground text-sm", INSET)}>
            {fonts.unavailable}
          </p>
        ) : null
      ) : list.length === 0 ? (
        <p className={cn("pb-2 text-muted-foreground text-sm", INSET)}>No font files yet</p>
      ) : (
        <ul className="border-border/50 border-t">
          {list.map((file) => (
            <li
              key={`${file.origin}:${file.path}`}
              className={cn(
                "flex min-h-11 items-center gap-4 border-border/50 border-b py-2 last:border-b-0",
                INSET,
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={file.path}>
                {fileName(file.path)}
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {extensionOf(file.path).toUpperCase()} · {formatSize(file.bytes)}
                {file.origin === "source" ? " · from code" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {fonts.progress !== null ? (
        <p className={cn("pt-2 text-muted-foreground text-xs", INSET)} role="status">
          {fonts.progress}
        </p>
      ) : null}
      {fonts.message !== null ? (
        <p
          role={fonts.message.problem ? "alert" : "status"}
          data-testid="font-upload-message"
          className={cn(
            "pt-2 text-sm",
            INSET,
            fonts.message.problem ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {fonts.message.text}
        </p>
      ) : null}
    </div>
  );
}
