import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";

import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { STUDIO_CONNECT_ACCOUNT_PAGES } from "./StudioConnectAccountPages";
import { useStudioConnectAuthPrompt } from "./useStudioConnectAuthPrompt";

export function StudioConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredStudioConnectSidebarSignIn />;
}

export function StudioConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredStudioConnectSidebarAvatar />;
}

function ConfiguredStudioConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      {STUDIO_CONNECT_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={page.label}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
    </UserButton>
  );
}

/**
 * Signing in here is this window's account session. A machine stays linked to
 * Connect without it, and fleet work from a main machine never needs it.
 */
export function studioConnectSidebarSignInCopy(linked: boolean): {
  readonly label: string;
  readonly tooltip: string;
} {
  return linked
    ? {
        label: "Connect linked · Sign in here",
        tooltip:
          "This machine is linked to SpecWithCode Connect, and work from your main machine reaches it without signing in. Sign in here to see and open your other machines from this window.",
      }
    : {
        label: "Sign in to SpecWithCode Connect",
        tooltip:
          "Sign in to see and open your machines from this window, or to link this machine to SpecWithCode Connect. Work from your main machine does not need it.",
      };
}

function ConfiguredStudioConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useStudioConnectAuthPrompt();
  const link = usePrimaryCloudLinkState();

  if (!isLoaded || isSignedIn) return null;
  const copy = studioConnectSidebarSignInCopy(link.data?.linked === true);

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt} title={copy.tooltip}>
            <LogInIcon />
            <span>{copy.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
