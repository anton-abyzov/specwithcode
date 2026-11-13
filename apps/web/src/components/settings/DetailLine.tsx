import type { ReactNode } from "react";
import { SettingHelp } from "./SettingHelp";

/** One labelled line of a machine card, with optional help behind an info icon. */
export function DetailLine({
  label,
  help,
  children,
}: {
  label: string;
  /** Shown on hover or tap beside the label. */
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1 pl-7">
      <p className="flex items-center gap-1 text-xs text-foreground/80">
        {label}
        {help ? <SettingHelp label={label}>{help}</SettingHelp> : null}
      </p>
      {children}
    </div>
  );
}
