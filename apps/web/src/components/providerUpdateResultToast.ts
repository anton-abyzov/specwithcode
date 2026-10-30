import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";

import { isProviderUpdateBlockedInUse } from "./ProviderUpdateLaunchNotification.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * Toast a single-instance update that did not go through: a command failure,
 * or a refusal only because the CLI was running, which offers "Update anyway".
 */
export function toastProviderUpdateResult(input: {
  readonly target: Pick<ServerProvider, "driver" | "instanceId">;
  readonly result: AtomCommandResult<
    { readonly providers: ReadonlyArray<ServerProvider> },
    unknown
  >;
  readonly updateAnyway: () => void;
}): void {
  const name = PROVIDER_DISPLAY_NAMES[input.target.driver] ?? input.target.driver;
  if (input.result._tag === "Failure") {
    if (isAtomCommandInterrupted(input.result)) return;
    const error = squashAtomCommandFailure(input.result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not update ${name}`,
        description:
          error instanceof Error
            ? error.message
            : "The provider update command could not be started.",
      }),
    );
    return;
  }
  const provider = input.result.value.providers.find(
    (candidate) => candidate.instanceId === input.target.instanceId,
  );
  if (!provider || !isProviderUpdateBlockedInUse(provider)) return;
  let toastId!: ReturnType<typeof toastManager.add>;
  toastId = toastManager.add(
    stackedThreadToast({
      type: "error",
      title: `${name} is running`,
      description: provider.updateState?.message ?? `${name} is running.`,
      timeout: 0,
      actionProps: {
        children: "Update anyway",
        onClick: () => {
          toastManager.close(toastId);
          input.updateAnyway();
        },
      },
      actionVariant: "outline",
    }),
  );
}
