/**
 * The header's More menu on a narrow header (see `headerLayout`). Without the
 * crumbs it carries their links and "Connect to a project…"; without the tools it also carries
 * the design-system picker, Version history, Export, Implement and Present,
 * whose header buttons are hidden then so Share never clips. Only what the
 * header lacks is rendered, so arrow keys and typeahead never land on a row
 * that is on screen elsewhere.
 */
import {
  CodeIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderIcon,
  FolderSymlinkIcon,
  HistoryIcon,
  PlayIcon,
  PresentationIcon,
  Redo2Icon,
  ShapesIcon,
  Undo2Icon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { EditorSystemMenuSub, type EditorSystemControl } from "./EditorSystemPicker";

/** A breadcrumb link: the owning project, or the list of designs it sits in. */
export interface EditorPlace {
  readonly kind: "project" | "designs";
  readonly label: string;
  readonly go: () => void;
}

export function EditorMoreMenu({
  narrow,
  crumbs,
  places = [],
  onUndo = null,
  onRedo = null,
  system,
  onConnect,
  onHistory,
  exportItems,
  onImplement,
  implementDisabled,
  onPresent,
  onPresenterView,
}: {
  /** The header hides its tools; they are here instead. */
  narrow: boolean;
  /** The header shows the breadcrumb, which offers its links and Connect itself. */
  crumbs: boolean;
  /** The breadcrumb's links, offered here while it is hidden. */
  places?: readonly EditorPlace[];
  /** Null when there is nothing to undo or redo (or the design is read-only). */
  onUndo?: (() => void) | null;
  onRedo?: (() => void) | null;
  system: EditorSystemControl;
  /** Playground designs only: "Connect to a project…". */
  onConnect: (() => void) | null;
  onHistory: (() => void) | null;
  exportItems: ReactNode;
  onImplement: (() => void) | null;
  implementDisabled: boolean;
  onPresent: () => void;
  onPresenterView: (() => void) | null;
}) {
  const connect = crumbs ? null : onConnect;
  const links = crumbs ? [] : places;
  const located = links.length > 0 || connect !== null;
  if (!narrow && !located) return null;
  return (
    // Remount closed when the header narrows or widens, so focus never sits on a removed item.
    <Menu key={narrow ? "narrow" : "wide"}>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More"
            data-testid="design-header-more"
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        {links.map((place) => (
          <MenuItem key={place.kind} onClick={place.go}>
            {place.kind === "project" ? <FolderIcon aria-hidden /> : <ShapesIcon aria-hidden />}
            {place.label}
          </MenuItem>
        ))}
        {connect !== null ? (
          <MenuItem data-testid="design-more-connect" onClick={connect}>
            <FolderSymlinkIcon aria-hidden />
            Connect to a project…
          </MenuItem>
        ) : null}
        {narrow ? (
          <>
            {located ? <MenuSeparator /> : null}
            <MenuItem disabled={onUndo === null} onClick={() => onUndo?.()}>
              <Undo2Icon aria-hidden />
              Undo
            </MenuItem>
            <MenuItem disabled={onRedo === null} onClick={() => onRedo?.()}>
              <Redo2Icon aria-hidden />
              Redo
            </MenuItem>
            <MenuSeparator />
            <EditorSystemMenuSub control={system} />
            {onHistory !== null ? (
              <MenuItem onClick={onHistory}>
                <HistoryIcon aria-hidden />
                Version history
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger>
                <DownloadIcon aria-hidden />
                Export
              </MenuSubTrigger>
              <MenuSubPopup className="min-w-56">{exportItems}</MenuSubPopup>
            </MenuSub>
            {onImplement !== null ? (
              <MenuItem disabled={implementDisabled} onClick={onImplement}>
                <CodeIcon aria-hidden />
                Implement this frame
              </MenuItem>
            ) : null}
            <MenuItem onClick={onPresent}>
              <PlayIcon aria-hidden />
              Present
            </MenuItem>
            {onPresenterView !== null ? (
              <MenuItem onClick={onPresenterView}>
                <PresentationIcon aria-hidden />
                Presenter view
              </MenuItem>
            ) : null}
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
