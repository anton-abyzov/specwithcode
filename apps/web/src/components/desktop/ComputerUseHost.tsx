import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@specweave-studio/contracts";

import { computerUseHost } from "../../state/computerUse";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";

const HOST_INPUT = { label: "SpecWithCode desktop app", platform: "macos" } as const;

function ComputerUseHostConnection({ environmentId }: { environmentId: EnvironmentId }) {
  useAtomValue(computerUseHost({ environmentId, input: HOST_INPUT }));
  return null;
}

/**
 * Desktop only. Offers this app to its own machine's server as the host that
 * performs agents' `computer_*` actions (screenshots, clicks, typing), so
 * agents can work in System Settings and other native apps.
 */
export function ComputerUseHost() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  if (environmentId === null || window.desktopBridge?.runComputerUseAction === undefined) {
    return null;
  }
  return <ComputerUseHostConnection environmentId={environmentId} />;
}
