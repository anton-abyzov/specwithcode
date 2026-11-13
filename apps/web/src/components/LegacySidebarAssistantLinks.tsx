import { PERSONAL_ASSISTANT_LABEL } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { ConciergeBellIcon } from "lucide-react";

import { useTx } from "../i18n";
import type { LegacySidebarAssistantLink } from "./LegacySidebar.logic";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

/**
 * Percy in the opt-in sidebars: one link row per assistant above the Projects list, to
 * the same page the studio sidebar's Percy row opens. Percy is never a project row there.
 */
export function LegacySidebarAssistantLinks({
  links,
  activeProjectKey,
}: {
  links: readonly LegacySidebarAssistantLink[];
  activeProjectKey: string | null;
}) {
  const tx = useTx();
  if (links.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarMenu aria-label={tx(PERSONAL_ASSISTANT_LABEL)}>
        {links.map((link) => (
          <SidebarMenuItem key={link.projectKey}>
            <SidebarMenuButton
              isActive={link.projectKey === activeProjectKey}
              render={
                <Link
                  to="/projects/$projectKey"
                  params={{ projectKey: link.projectKey }}
                  data-testid="sidebar-assistant-link"
                />
              }
            >
              <ConciergeBellIcon />
              <span className="flex-1 truncate">{link.title}</span>
              {link.hint ? (
                <span className="truncate text-sidebar-muted-foreground text-xs">{link.hint}</span>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
