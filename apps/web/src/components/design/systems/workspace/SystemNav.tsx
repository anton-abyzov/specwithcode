/**
 * The page's section list: a 240 px column with search on wide windows, and a
 * "Sections" menu in the header on narrow ones. Both end with the Files row.
 */
import {
  BlendIcon,
  BookTextIcon,
  BoxIcon,
  BracesIcon,
  CopyIcon,
  ExpandIcon,
  FolderIcon,
  ImageIcon,
  LayersIcon,
  ListIcon,
  MonitorSmartphoneIcon,
  PaletteIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SplineIcon,
  SquareRoundCornerIcon,
  TimerIcon,
  TypeIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../../ui/input-group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../../ui/menu";
import { searchSections, type SectionId, type SystemSection } from "./systemSections";
import { plural } from "./systemText";

const CORE_ICONS: Record<string, LucideIcon> = {
  readme: BookTextIcon,
  colors: PaletteIcon,
  type: TypeIcon,
  spacing: ExpandIcon,
  corners: SquareRoundCornerIcon,
  shadows: CopyIcon,
  components: BoxIcon,
  assets: ImageIcon,
};

const FAMILY_ICONS: Record<string, LucideIcon> = {
  duration: TimerIcon,
  easing: SplineIcon,
  breakpoint: MonitorSmartphoneIcon,
  zIndex: LayersIcon,
  control: SlidersHorizontalIcon,
  opacity: BlendIcon,
};

export function sectionIcon(section: Pick<SystemSection, "id" | "familyKey">): LucideIcon {
  if (section.familyKey !== undefined) return FAMILY_ICONS[section.familyKey] ?? BracesIcon;
  return CORE_ICONS[section.id] ?? BracesIcon;
}

/** The number a section shows at the right of its row; null where a count says nothing. */
export function sectionCount(section: SystemSection, componentCount: number): number | null {
  if (section.kind === "overview" || section.kind === "assets") return null;
  if (section.kind === "components") return componentCount;
  return section.tokens.length;
}

export function filesTitle(fileCount: number | null): string {
  return fileCount === null ? "Files" : plural(fileCount, "file");
}

const ROW =
  "group/nav flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground outline-none transition-colors duration-[120ms] hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";
const ACTIVE = "bg-accent text-foreground hover:bg-accent";

export interface SystemNavProps {
  readonly sections: readonly SystemSection[];
  readonly active: SectionId | null;
  readonly componentNames: readonly string[];
  readonly fileCount: number | null;
  readonly filesOpen: boolean;
  readonly onSelect: (id: SectionId) => void;
  /** A search hit: the section, then the token or component in it. */
  readonly onSelectItem: (id: SectionId, name: string) => void;
  readonly onOpenFiles: () => void;
}

export function SystemNav(props: SystemNavProps) {
  const [query, setQuery] = useState("");
  const search = searchSections(props.sections, query, props.componentNames);
  const searching = query.trim() !== "";
  return (
    <nav
      aria-label="Design system sections"
      className="hidden w-60 shrink-0 flex-col gap-3 overflow-y-auto border-border/60 border-r px-2 py-3 md:flex"
      data-testid="system-nav"
    >
      <InputGroup className="mx-1 w-auto">
        <InputGroupAddon>
          <SearchIcon aria-hidden className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          size="sm"
          value={query}
          placeholder="Search tokens"
          aria-label="Search sections and tokens"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
      </InputGroup>
      <ul className="flex flex-col gap-px" data-testid="system-nav-list">
        {search.matches.map(({ section, items }) => {
          const Icon = sectionIcon(section);
          const count = sectionCount(section, props.componentNames.length);
          const current = !props.filesOpen && props.active === section.id;
          return (
            <li key={section.id}>
              <button
                type="button"
                className={cn(ROW, current && ACTIVE)}
                aria-current={current ? "true" : undefined}
                data-nav-section={section.id}
                onClick={() => props.onSelect(section.id)}
              >
                <Icon aria-hidden className="size-4 shrink-0 opacity-80" />
                <span className="min-w-0 flex-1 truncate">{section.title}</span>
                {count !== null && count > 0 ? (
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                    {count}
                  </span>
                ) : null}
              </button>
              {items.length > 0 ? (
                <ul className="mt-px mb-1 flex flex-col gap-px pl-8">
                  {items.map((name) => (
                    <li key={name}>
                      <button
                        type="button"
                        className={cn(ROW, "h-7 font-mono text-xs")}
                        data-nav-item={name}
                        onClick={() => props.onSelectItem(section.id, name)}
                      >
                        <span className="truncate">{name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {searching && search.matches.length === 0 ? (
        <p className="px-2 text-muted-foreground text-xs" role="status">
          No matches for “{query.trim()}”
        </p>
      ) : null}
      {searching && search.shown < search.total ? (
        <p className="px-2 text-muted-foreground text-xs" role="status">
          Showing {search.shown} of {search.total} matches. Keep typing to narrow it down.
        </p>
      ) : null}
      <div className="mt-auto border-border/60 border-t pt-2">
        <button
          type="button"
          className={cn(ROW, props.filesOpen && ACTIVE)}
          aria-current={props.filesOpen ? "true" : undefined}
          title={filesTitle(props.fileCount)}
          data-testid="system-nav-files"
          onClick={props.onOpenFiles}
        >
          <FolderIcon aria-hidden className="size-4 shrink-0 opacity-80" />
          <span className="min-w-0 flex-1 truncate">Files</span>
          {props.fileCount !== null ? (
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {props.fileCount}
            </span>
          ) : null}
        </button>
      </div>
    </nav>
  );
}

/** The section list as a header menu, for windows too narrow for the column. */
export function SectionsMenu(
  props: Omit<SystemNavProps, "onSelectItem" | "componentNames"> & {
    readonly componentCount: number;
  },
) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="outline" size="xs" className="md:hidden" data-testid="sections-menu" />
        }
      >
        <ListIcon aria-hidden />
        Sections
      </MenuTrigger>
      <MenuPopup align="end" className="max-h-[min(32rem,70vh)] min-w-56">
        <MenuRadioGroup
          value={props.filesOpen ? "" : (props.active ?? "")}
          onValueChange={(value) => {
            const section = props.sections.find((candidate) => candidate.id === value);
            if (section !== undefined) props.onSelect(section.id);
          }}
        >
          {props.sections.map((section) => {
            const Icon = sectionIcon(section);
            const count = sectionCount(section, props.componentCount);
            return (
              <MenuRadioItem key={section.id} value={section.id} closeOnClick>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Icon aria-hidden className="size-4 shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1 truncate">{section.title}</span>
                  {count !== null && count > 0 ? (
                    <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
                  ) : null}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={props.onOpenFiles}>
          <FolderIcon aria-hidden />
          <span className="flex flex-1 items-center justify-between gap-4">
            Files
            {props.fileCount !== null ? (
              <span className="text-muted-foreground text-xs tabular-nums">{props.fileCount}</span>
            ) : null}
          </span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
