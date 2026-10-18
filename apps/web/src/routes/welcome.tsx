import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useClientSettings, useClientSettingsHydrationStatus } from "../hooks/useSettings";
import { useSetOnboardingMachineRole } from "../onboarding/firstRun";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

/** Onboarding overlays the workspace. Visiting /welcome reopens setup. */
export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const resumeEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
  // The root shell can remount this pending outlet after the location changes.
  // Never reopen setup while the destination route is still loading.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  const openNewThread = useNewThreadHandler();
  // An authenticated gate means a primary server is serving this app —
  // desktop, the `specweave-studio` CLI, or a dev server — and that server is "this machine"
  // no matter what hostname the browser used. Only hosted-static has no
  // local server to offer.
  const localAvailable = authGateState.status === "authenticated";
  const hydrated = useClientSettingsHydrationStatus() === "ready";
  const machineRole = useClientSettings((settings) => settings.onboardingMachineRole);
  const onboardingCompleted = useClientSettings(
    (settings) => settings.onboardingCompletedAt !== null,
  );
  const setMachineRole = useSetOnboardingMachineRole();
  return (
    <>
      <NoProjectsHero />
      {isWelcomeRoute && !dismissed ? (
        <WelcomeWizard
          localAvailable={localAvailable}
          resumeEnvironmentId={resumeEnvironmentId}
          machineRole={{
            // Only a first run with a server here offers the choice; anyone who
            // already finished first run reopens setup as before.
            offer: localAvailable && hydrated && !onboardingCompleted,
            role: hydrated ? machineRole : null,
            onChange: setMachineRole,
          }}
          onDone={async (projectRef) => {
            setDismissed(true);
            if (projectRef !== undefined) {
              await openNewThread(projectRef, { replace: true }).catch(() =>
                navigate({ to: "/", replace: true }),
              );
              return;
            }
            await navigate({ to: "/", replace: true });
          }}
        />
      ) : null}
    </>
  );
}
