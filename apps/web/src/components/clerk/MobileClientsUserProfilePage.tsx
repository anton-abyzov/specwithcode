import type { RelayClientDeviceRecord } from "@specweave-studio/contracts/relay";
import { SmartphoneIcon } from "lucide-react";

import { useManagedRelayDevices } from "../../cloud/managedRelayState";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  mobileClientNotificationDetail,
  mobileClientPlatformLabel,
  mobileClientUpdatedAtLabel,
} from "./MobileClientsUserProfilePage.logic";
import {
  ClerkUserProfileError,
  ClerkUserProfileList,
  ClerkUserProfileListSkeleton,
  ClerkUserProfilePage,
  ClerkUserProfileRefreshButton,
  ClerkUserProfileRow,
} from "./ClerkUserProfilePage";

function MobileClientStatusBadge({
  enabled,
  label,
}: {
  readonly enabled: boolean;
  readonly label: string;
}) {
  return (
    <Badge variant={enabled ? "success" : "outline"}>
      {label}: {enabled ? "On" : "Off"}
    </Badge>
  );
}

function MobileClientRow({ device }: { readonly device: RelayClientDeviceRecord }) {
  return (
    <ClerkUserProfileRow icon={<SmartphoneIcon className="size-4" />}>
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm leading-5 font-medium text-foreground">{device.label}</h3>
          <p className="text-xs leading-4.5 text-muted-foreground">
            {mobileClientPlatformLabel(device)}
          </p>
        </div>
        <p className="shrink-0 text-2xs leading-4 text-muted-foreground">
          {mobileClientUpdatedAtLabel(device.updatedAt)}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <MobileClientStatusBadge
          enabled={device.notifications.enabled}
          label="Push notifications"
        />
        <MobileClientStatusBadge enabled={device.liveActivities.enabled} label="Live Activities" />
      </div>
      <p className="mt-1.5 text-xs leading-4.5 text-muted-foreground">
        {mobileClientNotificationDetail(device)}
      </p>
    </ClerkUserProfileRow>
  );
}

function EmptyMobileClients() {
  return (
    <Empty size="compact">
      <EmptyMedia variant="icon">
        <SmartphoneIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No mobile clients</EmptyTitle>
        <EmptyDescription>
          Install SpecWithCode on your phone and sign in to SpecWithCode Connect to get push
          notifications and Live Activities.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function MobileClientsUserProfilePage() {
  const devicesState = useManagedRelayDevices();
  const devices = devicesState.data ?? [];
  const isInitialLoad =
    !devicesState.accountId || (devicesState.data === null && !devicesState.error);
  const hasErrorWithoutData = devicesState.error !== null && devicesState.data === null;

  return (
    <ClerkUserProfilePage
      title="Mobile clients"
      description="Mobile devices that get notifications from your environments."
      action={
        <ClerkUserProfileRefreshButton
          isPending={devicesState.isPending}
          onClick={devicesState.refresh}
        />
      }
    >
      {devicesState.error ? (
        <ClerkUserProfileError
          title="Could not load mobile clients"
          detail={devicesState.error}
          retryDisabled={devicesState.isPending}
          onRetry={devicesState.refresh}
        />
      ) : null}

      {isInitialLoad ? (
        <ClerkUserProfileListSkeleton label="Loading mobile clients" rows={2} />
      ) : hasErrorWithoutData ? null : devices.length > 0 ? (
        <ClerkUserProfileList label="Mobile clients on your account">
          {devices.map((device) => (
            <MobileClientRow key={device.deviceId} device={device} />
          ))}
        </ClerkUserProfileList>
      ) : (
        <div className="rounded-xl border bg-muted/16">
          <EmptyMobileClients />
        </div>
      )}
    </ClerkUserProfilePage>
  );
}
