/**
 * Settings > Machines on a device that waits for a machine to allow it (1327):
 * each machine's code, this device's ID and Copy, so a closed pop-up is never
 * the only place the code was.
 */
import { useTx } from "../../i18n";
import { InlineDeviceApprovalCode } from "../devices/inlineApprovalCode";
import { useWaitingCodes } from "../devices/waitingCodes";
import { SettingsSection } from "./settingsLayout";

export function WaitingJoinCodes() {
  const tx = useTx();
  const waiting = useWaitingCodes();
  if (waiting.length === 0) return null;
  return (
    <SettingsSection id="waiting-join-codes" title={tx("Waiting to join")}>
      <div className="space-y-3 px-3 py-3 sm:px-4" data-waiting-join-codes={waiting.length}>
        {waiting.map((entry) => (
          <InlineDeviceApprovalCode
            key={entry.id}
            environmentId={entry.id}
            machine={entry.machine}
            code={entry.code}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
