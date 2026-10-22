import { DEFAULT_RUNTIME_MODE, type RuntimeMode } from "@specweave-studio/contracts";

/**
 * The runtime mode for a turn the editor sends: the thread's own mode when the
 * app knows it, else the project's default, else the most restrictive mode.
 * The editor never raises a thread to full access on its own.
 */
export function designTurnRuntimeMode(
  threadMode: RuntimeMode | undefined,
  projectDefault: RuntimeMode | undefined,
): RuntimeMode {
  return threadMode ?? projectDefault ?? DEFAULT_RUNTIME_MODE;
}
