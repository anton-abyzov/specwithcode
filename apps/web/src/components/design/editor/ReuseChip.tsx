import type { DesignReuse } from "@specweave-studio/contracts";
import { FolderSearchIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

import { foundSystemFacts, foundSystemFolder } from "../gallery/foundSystems";

const PATHS_SHOWN = 6;

const day = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : at.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

/**
 * Where the design's look comes from when it reuses a design system found in
 * its repository rather than an imported one: the files, what they hold, and
 * how to import it.
 */
export function ReuseChip({
  reuse,
  named = false,
  onOpenSettings,
}: {
  reuse: DesignReuse;
  /** The header has room for the system's name beside the icon. */
  named?: boolean;
  /** Opens Settings > Design systems, where the proposal waits for review. */
  onOpenSettings: (() => void) | null;
}) {
  const folder = foundSystemFolder({ sources: [], paths: reuse.paths });
  const found = day(reuse.foundAt);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="xs"
            className="min-w-0 shrink"
            aria-label={`Reuses ${reuse.name} from this repository`}
            data-testid="design-reuse-chip"
          />
        }
      >
        <FolderSearchIcon aria-hidden />
        {named ? <span className="max-w-32 truncate">{reuse.name}</span> : null}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" width="md" data-testid="design-reuse-details">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="font-medium text-sm">Reuses {reuse.name}</p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Found in this repository{found === null ? "" : ` on ${found}`}. The agent reads these
              files and reuses their tokens and components.
            </p>
          </div>
          <div className="flex flex-col gap-0.5">
            <p className="truncate text-sm" title={folder}>
              {folder}
            </p>
            <p className="text-muted-foreground text-xs">{foundSystemFacts(reuse)}</p>
          </div>
          <ul className="flex flex-col gap-0.5 text-muted-foreground text-xs">
            {reuse.paths.slice(0, PATHS_SHOWN).map((path) => (
              <li key={path} className="truncate" title={path}>
                {path}
              </li>
            ))}
            {reuse.paths.length > PATHS_SHOWN ? (
              <li>and {reuse.paths.length - PATHS_SHOWN} more</li>
            ) : null}
          </ul>
          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <p className="text-muted-foreground text-xs">
              Import it to pick it by name in any design.
            </p>
            {onOpenSettings === null ? null : (
              <Button size="xs" variant="outline" onClick={onOpenSettings}>
                Review in Settings
              </Button>
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
