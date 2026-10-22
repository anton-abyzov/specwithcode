import { CopyIcon, EllipsisIcon, FileJsonIcon, PanelTopOpenIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";

/** A design row's actions in a project's Library. */
export function LibraryDesignMenu({
  title,
  canCopy,
  onOpen,
  onCopyToPlayground,
  onShowFile,
}: {
  title: string;
  canCopy: boolean;
  onOpen: () => void;
  onCopyToPlayground: () => void;
  onShowFile: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${title}`}
            data-testid="library-design-menu"
          />
        }
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuItem onClick={onOpen}>
          <PanelTopOpenIcon aria-hidden />
          Open
        </MenuItem>
        <MenuItem disabled={!canCopy} onClick={onCopyToPlayground}>
          <CopyIcon aria-hidden />
          Copy to Playground
        </MenuItem>
        <MenuItem onClick={onShowFile}>
          <FileJsonIcon aria-hidden />
          Show file
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
