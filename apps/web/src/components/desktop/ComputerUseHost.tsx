import { useAtomValue } from "@effect/atom-react";
import {
  computerUseHostPlatformFor,
  type ComputerUseHostInput,
  type EnvironmentId,
} from "@specweave-studio/contracts";

import { computerUseHost } from "../../state/computerUse";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";

const HOST_LABEL = "SpecWithCode desktop app";
const MAC_HOST_INPUT: ComputerUseHostInput = { label: HOST_LABEL, platform: "macos" };

/**
 * What this window offers its server. Only the macOS app can run actions; on
 * Windows and Linux it still connects with its platform, so the server tells
 * agents that computer use is unsupported here rather than that the app is closed.
 */
export function computerUseHostInput(
  bridge: Window["desktopBridge"] | undefined,
): ComputerUseHostInput | null {
  if (bridge === undefined) return null;
  if (bridge.runComputerUseAction !== undefined) return MAC_HOST_INPUT;
  const platform = computerUseHostPlatformFor(bridge.getClientPlatform?.());
  // A macOS bridge without the runner is an older preload: claim nothing.
  return platform === "macos" ? null : { label: HOST_LABEL, platform };
}

function ComputerUseHostConnection({
  environmentId,
  input,
}: {
  environmentId: EnvironmentId;
  input: ComputerUseHostInput;
}) {
  useAtomValue(computerUseHost({ environmentId, input }));
  return null;
}

/**
 * Desktop only. Offers this app to its own machine's server as the host that
 * performs agents' `computer_*` actions (screenshots, clicks, typing), so
 * agents can work in System Settings and other native apps. Elsewhere it
 * connects only to report that computer use is unsupported on its platform.
 */
export function ComputerUseHost() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const input = computerUseHostInput(window.desktopBridge);
  if (environmentId === null || input === null) return null;
  return <ComputerUseHostConnection environmentId={environmentId} input={input} />;
}
