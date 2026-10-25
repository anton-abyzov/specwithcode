/**
 * The design-system field of the creation dialogs: "Found in this
 * repository" first, then the owner's systems, then other projects' systems
 * (copied in at creation). A found system shows where it lives and what it
 * holds, painted with its own colors.
 */
import type { DesignSystemSummary } from "@specweave-studio/contracts";
import type { CSSProperties, ReactNode } from "react";
import { PaletteIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { copyInLabel } from "../systems/DesignSystemPicker";
import { copyIn, copyPredatesSource, systemKey } from "../systems/reviewModel";
import {
  chosenCopy,
  chosenFound,
  decodeChoice,
  encodeChoice,
  type ScanState,
  type SystemChoice,
  type SystemOptions,
} from "./creationSystem";
import {
  foundSystemFacts,
  foundSystemFolder,
  paintableSwatches,
  type FoundSwatch,
  type FoundSystem,
} from "./foundSystems";

const swatchStyle = (swatch: FoundSwatch) =>
  ({
    "--swatch": swatch.value,
    "--swatch-dark": swatch.darkValue ?? swatch.value,
  }) as CSSProperties;

/** Four of the system's colors as a small square, the system's mark in the list. */
/** Drawn over the colors, so a swatch near the card's own color keeps its edge. */
const OUTLINE =
  "after:pointer-events-none after:absolute after:inset-0 after:ring-1 after:ring-inset after:content-['']";

function SwatchTile({ found, className }: { found: FoundSystem; className?: string }) {
  const swatches = paintableSwatches(found).slice(0, 4);
  if (swatches.length === 0)
    return <PaletteIcon aria-hidden className={cn("size-4 text-muted-foreground", className)} />;
  const cells = Array.from({ length: 4 }, (_, index) => swatches[index % swatches.length]!);
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid size-4 shrink-0 grid-cols-2 overflow-hidden rounded-[4px] after:rounded-[4px] after:ring-foreground/15",
        OUTLINE,
        className,
      )}
    >
      {cells.map((swatch, index) => (
        <span
          key={index}
          className="bg-(--swatch) dark:bg-(--swatch-dark)"
          style={swatchStyle(swatch)}
        />
      ))}
    </span>
  );
}

/** Up to eight colors as one strip, light or dark with the app's theme. */
function SwatchStrip({ found }: { found: FoundSystem }) {
  const swatches = paintableSwatches(found).slice(0, 8);
  if (swatches.length === 0) return null;
  return (
    <div
      className={cn(
        "relative flex h-6 overflow-hidden rounded-md after:rounded-md after:ring-foreground/12",
        OUTLINE,
      )}
      data-testid="creation-system-swatches"
    >
      {swatches.map((swatch) => (
        <span
          key={swatch.name}
          title={`--${swatch.name}: ${swatch.value}${swatch.darkValue ? ` (dark ${swatch.darkValue})` : ""}`}
          className="min-w-0 flex-1 bg-(--swatch) dark:bg-(--swatch-dark)"
          style={swatchStyle(swatch)}
        />
      ))}
    </div>
  );
}

function FoundRow({ found }: { found: FoundSystem }) {
  return (
    <span className="flex min-w-0 items-start gap-2.5 py-0.5">
      <SwatchTile found={found} className="mt-0.5" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{found.name}</span>
        <span className="truncate text-muted-foreground text-xs">
          {foundSystemFolder(found)}, {foundSystemFacts(found)}
        </span>
      </span>
    </span>
  );
}

/** The card under the field once a found system is chosen: where it lives and what it holds. */
export function FoundSystemCard({
  found,
  truncated,
  project,
  verb,
}: {
  found: FoundSystem;
  truncated: boolean;
  project: string;
  verb: "create" | "start";
}) {
  const folder = foundSystemFolder(found);
  return (
    <div
      className="flex flex-col gap-2.5 rounded-lg border border-border/70 bg-muted/30 p-3"
      data-testid="creation-system-found-card"
    >
      <SwatchStrip found={found} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="truncate text-foreground text-sm" title={folder}>
          {folder}
        </p>
        <p className="text-muted-foreground text-xs">{foundSystemFacts(found)}</p>
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {verb === "create"
          ? // New designs import the chosen system (DesignGalleryPage, onCreateDesign).
            `Found in this repository. When you create, it is imported into ${project} as a design system, so the design keeps its tokens and you can pick it by name later.`
          : "Found in this repository. The agent reads these files and reuses their tokens and components. Import it in Settings > Design systems to pick it by name later."}
        {truncated ? " The repository is large, so the scan skipped some folders." : ""}
      </p>
    </div>
  );
}

/** What Create or Start does with another owner's system: copy it, copy it again, or use the copy. */
function copyHint(input: {
  readonly name: string;
  readonly existing: DesignSystemSummary | undefined;
  readonly source: DesignSystemSummary;
  readonly fresh: boolean;
  readonly ownerLabel: string;
  readonly verb: "create" | "start";
}): string {
  const { name, ownerLabel, verb } = input;
  if (input.fresh)
    return `A fresh copy of ${name} is made in ${ownerLabel} when you ${verb}. Cancel copies nothing.`;
  if (input.existing === undefined)
    return `${name} is copied into ${ownerLabel} when you ${verb}. Cancel copies nothing.`;
  return copyPredatesSource(input.existing, input.source)
    ? `${ownerLabel} already has a copy of ${name}, made before its latest change. The design uses that copy.`
    : `${ownerLabel} already has a copy of ${name}. The design uses that copy.`;
}

function Hint({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p
      className="flex items-center gap-1.5 text-muted-foreground text-xs"
      {...(testId ? { "data-testid": testId } : {})}
    >
      {children}
    </p>
  );
}

export function CreationSystemPicker({
  id,
  options,
  value,
  onChange,
  scan,
  onScanAgain,
  projectTitle,
  ownerLabel,
  verb,
  disabled = false,
}: {
  id: string;
  options: SystemOptions;
  /** The choice in effect (see `effectiveChoice`). */
  value: SystemChoice | null;
  onChange: (choice: SystemChoice | null) => void;
  /** The owner's repository scan; null when the owner has no repository or has systems. */
  scan: ScanState | null;
  onScanAgain: (() => void) | null;
  projectTitle: string | null;
  /** Where the design is saved, for "Copied into <owner>". */
  ownerLabel: string;
  /** What the dialog's button does: "create" or "start". */
  verb: "create" | "start";
  disabled?: boolean;
}) {
  const found = chosenFound(value, options);
  const copy = chosenCopy(value, options);
  const own =
    value?.kind === "own"
      ? (options.own.find((system) => system.ref.systemId === value.systemId) ?? null)
      : null;
  const label =
    found !== null ? (
      <span className="flex min-w-0 items-center gap-2">
        <SwatchTile found={found} />
        <span className="truncate">{found.name}</span>
      </span>
    ) : copy !== null ? (
      copy.name
    ) : value?.kind === "own" ? (
      (own?.name ?? "Loading…")
    ) : value?.kind === "none" ? (
      "No design system"
    ) : (
      <span className="text-muted-foreground">Choose design system…</span>
    );
  const project = projectTitle ?? "this project";
  const scanAgain =
    onScanAgain === null ? null : (
      <Button
        type="button"
        variant="link"
        size="micro"
        className="h-auto px-0 text-xs text-foreground"
        onClick={onScanAgain}
        data-testid="creation-system-scan-again"
      >
        Scan again
      </Button>
    );

  return (
    <div className="flex flex-col gap-2" data-testid="creation-system-picker">
      <Select
        value={encodeChoice(value)}
        onValueChange={(next) => onChange(decodeChoice(next))}
        disabled={disabled}
      >
        <SelectTrigger id={id} size="sm" data-testid="creation-system-trigger">
          <SelectValue>{label}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.found.length > 0 ? (
            <SelectGroup>
              <SelectGroupLabel>Found in this repository</SelectGroupLabel>
              {options.found.map((candidate) => (
                <SelectItem
                  key={candidate.key}
                  value={encodeChoice({ kind: "found", key: candidate.key })}
                  data-testid="creation-system-found"
                >
                  <FoundRow found={candidate} />
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {options.own.length > 0 ? (
            <SelectGroup>
              <SelectGroupLabel>{ownerLabel}</SelectGroupLabel>
              {options.own.map((system) => (
                <SelectItem
                  key={system.ref.systemId}
                  value={encodeChoice({ kind: "own", systemId: system.ref.systemId })}
                >
                  {system.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {options.others.length > 0 ? (
            <SelectGroup>
              <SelectGroupLabel>Other projects</SelectGroupLabel>
              {options.others.flatMap((system) => {
                const key = systemKey(system);
                // The server returns the owner's copy instead of another, so the row says so.
                const existing = copyIn(options.own, system);
                const row = (
                  <SelectItem
                    key={key}
                    value={encodeChoice({ kind: "copy", key })}
                    data-testid="creation-system-copy"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{system.name}</span>
                      <span className="truncate text-muted-foreground text-xs">
                        {existing === undefined
                          ? `From ${system.ownerLabel}, copied into ${ownerLabel} when you ${verb}`
                          : `From ${system.ownerLabel} · ${copyInLabel(existing, system, ownerLabel)}`}
                      </span>
                    </span>
                  </SelectItem>
                );
                if (existing === undefined || !copyPredatesSource(existing, system)) return [row];
                return [
                  row,
                  <SelectItem
                    key={`fresh:${key}`}
                    value={encodeChoice({ kind: "copy", key, fresh: true })}
                    data-testid="creation-system-fresh"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{system.name}</span>
                      <span className="truncate text-muted-foreground text-xs">
                        From {system.ownerLabel} · Make a fresh copy in {ownerLabel} when you {verb}
                      </span>
                    </span>
                  </SelectItem>,
                ];
              })}
            </SelectGroup>
          ) : null}
          <SelectGroup>
            {options.found.length + options.own.length + options.others.length > 0 ? (
              <div role="separator" className="mx-2 my-1 h-px bg-border/70" />
            ) : null}
            <SelectItem value={encodeChoice({ kind: "none" })}>No design system</SelectItem>
          </SelectGroup>
        </SelectPopup>
      </Select>
      {found !== null ? (
        <FoundSystemCard
          found={found}
          truncated={scan?.status === "done" && scan.truncated}
          project={project}
          verb={verb}
        />
      ) : copy !== null ? (
        <Hint testId="creation-system-hint">
          {copyHint({
            name: copy.name,
            existing: copyIn(options.own, copy),
            source: copy,
            fresh: value?.kind === "copy" && value.fresh === true,
            ownerLabel,
            verb,
          })}
        </Hint>
      ) : value?.kind === "own" ? (
        <Hint testId="creation-system-hint">The agent uses its tokens and components.</Hint>
      ) : scan?.status === "scanning" ? (
        <Hint testId="creation-system-scanning">
          <Spinner size="xs" />
          Looking for a design system in {project}…
        </Hint>
      ) : scan?.status === "failed" ? (
        <Hint testId="creation-system-hint">
          <span>
            Could not scan {project}: {scan.message.replace(/\.$/, "")}.
          </span>
          {scanAgain}
        </Hint>
      ) : scan?.status === "done" && options.own.length === 0 ? (
        <Hint testId="creation-system-hint">
          <span>
            {options.found.length === 0
              ? `No tokens or component libraries found in ${project}. The agent matches the styles it finds in the code.`
              : "The agent matches the styles it finds in the code."}
            {scan.truncated ? " The repository is large, so the scan skipped some folders." : ""}
          </span>
          {options.found.length === 0 ? scanAgain : null}
        </Hint>
      ) : null}
    </div>
  );
}
