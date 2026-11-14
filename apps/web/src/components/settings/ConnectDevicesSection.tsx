import type { EnvironmentId } from "@specweave-studio/contracts";

import {
  useConnectDevices,
  useConnectDevicesActions,
  useDeviceApprovalSupported,
} from "../devices/ConnectDeviceHosts";
import { ConnectDevicesSectionView } from "../devices/ConnectDeviceViews";

/**
 * Settings > Machines: who besides this app may use this machine over
 * SpecWithCode Connect, with any device waiting for a code (1327).
 */
export function ConnectDevicesSection({ environmentId }: { environmentId: EnvironmentId }) {
  const supported = useDeviceApprovalSupported(environmentId);
  const { snapshot, error, refresh } = useConnectDevices(environmentId, supported);
  const actions = useConnectDevicesActions(
    environmentId,
    snapshot?.machine ?? "this machine",
    refresh,
  );
  return (
    <ConnectDevicesSectionView
      supported={supported}
      snapshot={snapshot}
      error={error}
      actions={actions}
    />
  );
}
