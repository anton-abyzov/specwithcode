import { ArrowLeftIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { Link, useLocation } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { StudioWordmark } from "../StudioWordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { SidebarAccountMenu } from "../account/SidebarAccountMenu";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarRestartToUpdate } from "./SidebarRestartToUpdate";
import { SidebarServerUpdate } from "./SidebarServerUpdate";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { ModStatusItems } from "../../mods/ModPanes";
import { DesktopUpdateDownloadedToast } from "../desktopUpdate.toast";

const isSettingsPath = (pathname: string) =>
  pathname === "/settings" || pathname.startsWith("/settings/");

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    // The titlebar row, not a padded SidebarHeader: it aligns to the window controls.
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:pl-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        // Over the stage artwork: the media viewer's control-on-imagery treatment.
        variant={backdropVariant ? "media-navigation" : "ghost"}
        className="relative top-auto z-10 translate-y-0 md:hidden"
      />
      {/* One visible line: the pill wraps onto the clipped second line once it no longer fits.
          The padding keeps the brand's focus ring inside the clip. */}
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand onBackdrop={backdropVariant !== null} />
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});

// Measures the brand at its titlebar inset, plus the header's right padding and the
// sidebar border, so the sidebar minimum follows font size, zoom and macOS window controls.
export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = useCallback(
    (probe: HTMLDivElement) => {
      const observer = new ResizeObserver(([entry]) => {
        if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
      });
      observer.observe(probe);
      return () => observer.disconnect();
    },
    [onWidthChange],
  );

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex">
        <SidebarBrandMark onBackdrop={false} />
      </div>
    </div>
  );
}

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <SidebarBrandMark onBackdrop={onBackdrop} />
    </Link>
  );
}

function SidebarBrandMark({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    // An 18 px tile centred on the name. The name keeps its full 20 px line box, so
    // `truncate`'s overflow clip leaves descenders such as the "p" whole.
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium tracking-tight">
      <StudioWordmark aria-label="SpecWithCode" className="size-[18px] shrink-0" />
      <span
        className={cn("truncate leading-5", onBackdrop ? "text-white/70" : "text-muted-foreground")}
      >
        SpecWithCode
      </span>
    </span>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    // Settings is a modal with its own close button over this sidebar.
    select: (location) =>
      isSidebarUtilityPage(location.pathname) && !isSettingsPath(location.pathname),
  });
  const handleBackClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigateToMainApp();
  }, [isMobile, navigateToMainApp, setOpenMobile]);

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      <SidebarAccountMenu compact={isOnUtilityPage} />
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarServerUpdate />
      <SidebarUpdateArchitectureWarning />
      <ModStatusItems />
      <SidebarRestartToUpdate />
      <DesktopUpdateDownloadedToast />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
