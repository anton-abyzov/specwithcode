import type {
  DesignSystemComponentChange,
  DesignSystemProposedFile,
  DesignSystemTokenChange,
  DesignTokenValue,
} from "@specweave-studio/contracts";
import { ArrowRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Badge } from "../../ui/badge";
import { Checkbox } from "../../ui/checkbox";
import { displayValue, locationLabel, swatchColor, tokenModes } from "./reviewModel";
import { formatSize } from "./workspace/filesModel";

function Swatch({ value }: { value: DesignTokenValue | undefined }) {
  const color = swatchColor(value);
  if (color === null) return null;
  return (
    <span
      aria-hidden
      data-testid="token-swatch"
      className="inline-block size-3.5 shrink-0 rounded-xs border border-foreground/15 shadow-xs/5"
      style={{ backgroundColor: color }}
    />
  );
}

function Value({ value, muted }: { value: DesignTokenValue | undefined; muted?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Swatch value={value} />
      <code
        className={cn(
          "min-w-0 truncate font-mono text-2xs",
          muted ? "text-muted-foreground line-through decoration-muted-foreground/50" : "",
        )}
      >
        {displayValue(value)}
      </code>
    </span>
  );
}

function RowCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean | null;
  onChange: ((ticked: boolean) => void) | null;
}) {
  if (checked === null || onChange === null) return <span className="size-4" aria-hidden />;
  return (
    <Checkbox
      className="mt-0.5"
      aria-label={label}
      checked={checked}
      onCheckedChange={(next) => onChange(next === true)}
    />
  );
}

/** One token: values per mode, before and after for a change, and where it was read. */
export function TokenRow({
  change,
  modes,
  checked,
  onChange,
}: {
  change: DesignSystemTokenChange;
  modes: readonly { id: string; name: string }[];
  /** null for unchanged rows, which have nothing to tick. */
  checked: boolean | null;
  onChange: ((ticked: boolean) => void) | null;
}) {
  const shown = tokenModes(change, modes);
  const first = Object.values(change.token.values)[0];
  return (
    <li
      data-testid="token-row"
      data-name={change.name}
      data-change={change.change}
      className="grid grid-cols-[auto_minmax(0,16rem)_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-3 py-2"
    >
      <RowCheckbox label={`Include ${change.name}`} checked={checked} onChange={onChange} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <code className="break-all font-mono text-xs text-foreground">{change.name}</code>
          <Badge variant="outline" size="sm">
            {change.token.type}
          </Badge>
        </div>
        {first ? (
          <p className="break-all font-mono text-2xs text-muted-foreground">
            {locationLabel(first.provenance)}
          </p>
        ) : null}
      </div>
      <ul className="flex min-w-0 flex-col gap-1">
        {shown.map((mode) => {
          const next = change.token.values[mode.id];
          const before = change.previous?.values[mode.id];
          const differs =
            change.change === "changed" && displayValue(before) !== displayValue(next);
          return (
            <li key={mode.id} className="flex min-w-0 items-center gap-2 text-xs">
              {shown.length > 1 || mode.id !== "default" ? (
                <span className="w-16 shrink-0 truncate text-muted-foreground">{mode.name}</span>
              ) : null}
              {differs ? (
                <span className="flex min-w-0 items-center gap-1.5" data-testid="token-diff">
                  <Value value={before} muted />
                  <ArrowRightIcon aria-label="becomes" className="size-3 shrink-0" />
                  <Value value={next} />
                </span>
              ) : (
                <Value value={next ?? before} muted={change.change === "removed"} />
              )}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

const FRAMEWORK_LABELS: Record<DesignSystemComponentChange["component"]["framework"], string> = {
  react: "React",
  "css-class": "CSS class",
  html: "HTML",
  other: "Other",
};

/** One component: kind, variants and where it was found. */
export function ComponentRow({
  change,
  checked,
  onChange,
}: {
  change: DesignSystemComponentChange;
  checked: boolean | null;
  onChange: ((ticked: boolean) => void) | null;
}) {
  const component = change.component;
  const variants = component.variants ?? [];
  const previousVariants = change.previous?.variants ?? null;
  return (
    <li
      data-testid="component-row"
      data-id={change.id}
      data-change={change.change}
      className="grid grid-cols-[auto_minmax(0,16rem)_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-3 py-2"
    >
      <RowCheckbox label={`Include ${component.name}`} checked={checked} onChange={onChange} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">{component.name}</span>
          <Badge variant="outline" size="sm">
            {FRAMEWORK_LABELS[component.framework]}
          </Badge>
        </div>
        <p className="break-all font-mono text-2xs text-muted-foreground">
          {locationLabel(component.provenance)}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-xs">
        {component.importPath ? (
          <code className="truncate font-mono text-2xs text-muted-foreground">
            {component.importPath}
          </code>
        ) : null}
        {variants.length > 0 ? (
          <span className="flex min-w-0 flex-wrap gap-1">
            {variants.map((variant) => (
              <Badge
                key={variant}
                variant={
                  previousVariants !== null && !previousVariants.includes(variant)
                    ? "info"
                    : "secondary"
                }
                size="sm"
              >
                {variant}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">No variants</span>
        )}
      </div>
    </li>
  );
}

/** A brand file the import would store: where it lands, where it comes from, its size. */
export function FileRow({
  file,
  checked,
  onChange,
}: {
  file: DesignSystemProposedFile;
  checked: boolean;
  onChange: (ticked: boolean) => void;
}) {
  return (
    <li
      data-testid="file-row"
      data-path={file.path}
      className="grid grid-cols-[auto_minmax(0,16rem)_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-3 py-2"
    >
      <RowCheckbox label={`Include ${file.path}`} checked={checked} onChange={onChange} />
      <div className="min-w-0">
        <span className="block truncate text-xs font-medium text-foreground">{file.path}</span>
        <span className="text-2xs text-muted-foreground">{formatSize(file.bytes)}</span>
      </div>
      <code className="break-all font-mono text-2xs text-muted-foreground">{file.source}</code>
    </li>
  );
}
