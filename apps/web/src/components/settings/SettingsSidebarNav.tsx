import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ArchiveIcon,
  BlocksIcon,
  BotIcon,
  createLucideIcon,
  CalendarClockIcon,
  GitBranchIcon,
  HardDriveIcon,
  PanelsTopLeftIcon,
  KeyboardIcon,
  LaptopIcon,
  Link2Icon,
  ChromeIcon,
  MailIcon,
  MessageCircleIcon,
  PaletteIcon,
  PuzzleIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  SwatchBookIcon,
  XIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarInput,
} from "../ui/sidebar";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettingsBySection,
  isSettingsOverviewVisible,
  settingsSearchDestination,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchResult,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { validateSettingsScopeSearch } from "./settingsScope";

const SnapShotIcon = createLucideIcon("snap-shot", [
  [
    "path",
    {
      d: "M8 3H6a3 3 0 0 0-3 3v2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2",
      key: "capture-frame",
    },
  ],
  ["rect", { width: "10", height: "8", x: "7", y: "8", rx: "2", key: "window" }],
  ["circle", { cx: "12", cy: "12", r: "1.5", key: "lens" }],
]);

const StudioConnectSidebarSignIn = lazy(() =>
  import("../clerk/StudioConnectSidebarSignIn").then((module) => ({
    default: module.StudioConnectSidebarSignIn,
  })),
);
const StudioConnectSidebarAvatar = lazy(() =>
  import("../clerk/StudioConnectSidebarSignIn").then((module) => ({
    default: module.StudioConnectSidebarAvatar,
  })),
);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/privacy": ShieldCheckIcon,
  "/settings/agents": BotIcon,
  "/settings/appearance": PaletteIcon,
  "/settings/design-systems": SwatchBookIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/skills": SparklesIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/snap-shot": SnapShotIcon,
  "/settings/providers": BotIcon,
  "/settings/integrations": BlocksIcon,
  "/settings/scheduled-tasks": CalendarClockIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/storage": HardDriveIcon,
  "/settings/mods": PuzzleIcon,
  "/settings/messaging": MessageCircleIcon,
  "/settings/google": MailIcon,
  "/settings/connections": Link2Icon,
  "/settings/machines": LaptopIcon,
  "/settings/chrome": ChromeIcon,
  "/settings/archived": ArchiveIcon,
};

const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  group: string;
  label: string;
  to: SettingsPath;
  icon: ComponentType<{ className?: string }>;
}> = SETTINGS_NAV_GROUPS.flatMap((group) =>
  group.paths.map((to) => ({
    group: group.label,
    to,
    label: SETTINGS_SECTION_LABELS[to],
    icon: SETTINGS_SECTION_ICONS[to],
  })),
);

export function groupSettingsNavItems<Item extends { to: SettingsPath }>(items: readonly Item[]) {
  const grouped = SETTINGS_NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.paths.flatMap((path) => items.filter((item) => item.to === path)),
  }));
  const placed = new Set(SETTINGS_NAV_GROUPS.flatMap((group) => group.paths));
  const rest = items.filter((item) => !placed.has(item.to));
  if (rest.length > 0) grouped[0] = { ...grouped[0]!, items: [...grouped[0]!.items, ...rest] };
  return grouped.filter((group) => group.items.length > 0);
}

/** The clicked section wins until navigation settles, then the location decides. */
export function isSettingsNavItemActive(
  to: SettingsPath,
  pathname: string,
  pendingSection: SettingsPath | null,
) {
  if (pendingSection !== null) return pendingSection === to;
  if (to === "/settings/general" && pathname === "/settings/open-source-licenses") return true;
  return pathname === to || pathname.startsWith(`${to}/`);
}

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground" />;
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const currentSearch = useLocation({ select: (location) => location.search });
  const scopeSearch = useMemo(() => validateSettingsScopeSearch(currentSearch), [currentSearch]);
  const navItems = SETTINGS_NAV_ITEMS.filter(
    // Skills also has a machine-wide view, so it shows without a project.
    (item) => item.to !== "/settings/projects" || isSettingsOverviewVisible(scopeSearch),
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const searchableItems = useAvailableSettingsSearchItems(scopeSearch);
  const navSections = useMemo(() => navItems.map((item) => item.to), [navItems]);
  const results = useMemo(
    () => searchSettingsBySection(query, searchableItems, navSections),
    [navSections, query, searchableItems],
  );
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;

  useEffect(() => {
    setActiveResultIndex((index) => Math.min(index, Math.max(results.length - 1, 0)));
  }, [results.length]);

  useEffect(() => {
    const result = results[activeResultIndex];
    if (!result) return;
    document
      .getElementById(`settings-search-result-${result.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          // Keep focus inside dialogs and popups opened over Settings
          // instead of escaping their focus trap into the search.
          target.closest(
            '[role="dialog"]:not([data-settings-dialog]), [aria-modal="true"]:not([data-settings-dialog]), [data-slot$="popup"]:not([data-settings-dialog])',
          ) !== null)
      ) {
        return;
      }

      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // A lazily loaded section updates the location only once its chunk arrives;
  // mark the clicked item selected right away so the highlight never lags.
  const [pendingSection, setPendingSection] = useState<SettingsPath | null>(null);
  useEffect(() => setPendingSection(null), [pathname]);
  const handleSectionClick = useCallback(
    (to: SettingsPath) => {
      setPendingSection(to);
      // A blocked or failed navigation must not leave the wrong item selected.
      void navigate({
        to,
        hash: "",
        replace: true,
        hashScrollIntoView: false,
      }).finally(() => setPendingSection(null));
    },
    [navigate],
  );
  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const handleSearchResultClick = useCallback(
    (result: SettingsSearchResult) => {
      clearSearch();
      if (result.kind === "section") {
        handleSectionClick(result.section);
        return;
      }
      const item = result.row;
      const targetId = item.targetId ?? item.id;
      const to = settingsSearchDestination(item, scopeSearch);
      if (pathname === to && currentHash.replace(/^#/, "") === targetId) {
        scrollToSettingsTarget(targetId);
        return;
      }
      void navigate({
        to,
        hash: targetId,
        replace: true,
        hashScrollIntoView: false,
        state: { settingsTargetHighlight: true },
      });
    },
    [clearSearch, currentHash, handleSectionClick, navigate, pathname, scopeSearch],
  );
  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && isSearching) {
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveResultIndex((index) => (index + 1) % results.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = results[activeResultIndex];
        if (result) handleSearchResultClick(result);
      }
    },
    [activeResultIndex, clearSearch, handleSearchResultClick, isSearching, results],
  );
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <div className="flex flex-col gap-2">
            <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
              <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
              <SidebarInput
                ref={searchInputRef}
                nativeInput
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveResultIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search"
                aria-label="Search settings"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isSearching && hasResults}
                aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
                aria-activedescendant={
                  isSearching && results[activeResultIndex]
                    ? `settings-search-result-${results[activeResultIndex].id}`
                    : undefined
                }
                className="min-w-0 flex-1"
              />
              {isSearching ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear settings search"
                  onClick={() => {
                    clearSearch();
                    searchInputRef.current?.focus();
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : (
                <Kbd>/</Kbd>
              )}
            </div>
            {isSearching && results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                No settings found
              </p>
            ) : null}
            {isSearching ? (
              <SidebarMenu
                id={hasResults ? "settings-search-results" : undefined}
                role={hasResults ? "listbox" : undefined}
                aria-label={hasResults ? "Settings search results" : undefined}
              >
                {results.map((result, index) => (
                  <SidebarMenuItem key={result.id} role="presentation">
                    <SidebarMenuButton
                      id={`settings-search-result-${result.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      data-search-result-kind={result.kind}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className={
                        result.kind === "section"
                          ? cn("h-auto min-h-8 items-center", index > 0 && "mt-2")
                          : "h-auto min-h-7 items-center ps-7"
                      }
                      onMouseMove={() => setActiveResultIndex(index)}
                      onClick={() => handleSearchResultClick(result)}
                    >
                      {result.kind === "section" ? (
                        <>
                          <SettingsSectionIcon to={result.section} />
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-sidebar-foreground">
                            {result.label}
                          </span>
                        </>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground">
                          {result.row.title}
                        </span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : (
              <nav aria-label="Settings sections" className="flex flex-col gap-4">
                {groupSettingsNavItems(navItems).map((group) => (
                  <div key={group.label} className="flex flex-col gap-1">
                    <div className="px-2 text-xs font-medium text-sidebar-muted-foreground">
                      {group.label}
                    </div>
                    <SidebarMenu>
                      {group.items.map((item) => {
                        const Icon = item.icon;
                        const isActive = isSettingsNavItemActive(item.to, pathname, pendingSection);
                        return (
                          <SidebarMenuItem key={item.to}>
                            <SidebarMenuButton
                              isActive={isActive}
                              aria-current={isActive ? "page" : undefined}
                              onClick={() => handleSectionClick(item.to)}
                            >
                              <Icon />
                              <span className="truncate">{item.label}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </div>
                ))}
              </nav>
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Suspense fallback={null}>
          <StudioConnectSidebarSignIn />
        </Suspense>
        <div className="flex items-center justify-end gap-1 empty:hidden">
          <Suspense fallback={null}>
            <StudioConnectSidebarAvatar />
          </Suspense>
        </div>
      </SidebarFooter>
    </>
  );
}
