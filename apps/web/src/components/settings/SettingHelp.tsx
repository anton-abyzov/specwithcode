import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/** An info button that opens on hover and on tap: touch screens have no hover. */
export function SettingHelp({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        render={<Button size="icon-micro" variant="ghost-muted" aria-label={`About ${label}`} />}
      >
        <InfoIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup
        aria-label={`About ${label}`}
        side="top"
        width="sm"
        padding="compact"
        className="text-xs"
      >
        {children}
      </PopoverPopup>
    </Popover>
  );
}
