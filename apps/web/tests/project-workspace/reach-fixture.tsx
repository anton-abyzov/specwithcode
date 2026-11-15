/* `?reach=<state>`: the project's other machine, Build Mac, in one reach state.
   `?rows&remote&reach=<state>` renders the real project workspace (Threads pane, its
   availability notice, groups and rows) with the app's reach judgement supplied as the
   UnreachableHostsProvider would supply it. `?banner=<state>` renders the real chat
   composer banner for that machine as ChatView builds it. Synthetic data only. */
import { isMachineReachDown, type MachineReachState } from "@specweave-studio/client-runtime/connection";
import { HourglassIcon, WifiOffIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ComposerBannerStack } from "../../src/components/chat/ComposerBannerStack";
import { environmentUnavailableBanner } from "../../src/components/chat/environmentUnavailableBanner";
import { Button } from "../../src/components/ui/button";
import { MachineReachContext, UnreachableHostsContext } from "../../src/studio/unreachableHosts";
import { REACH_NOW, reachConnection } from "./mocks";

export function ReachProviders({ state, children }: { state: string; children: ReactNode }) {
  const reach = state as MachineReachState;
  return (
    <UnreachableHostsContext.Provider value={new Set(isMachineReachDown(reach) ? ["m1"] : [])}>
      <MachineReachContext.Provider value={new Map([["m1", reach]])}>
        {children}
      </MachineReachContext.Provider>
    </UnreachableHostsContext.Provider>
  );
}

export function ReachBannerFixture({ state }: { state: string }) {
  const connection = reachConnection(state);
  const banner = environmentUnavailableBanner({
    label: "Build Mac",
    connection,
    isThisMachine: false,
    reach: state as MachineReachState,
  });
  const description = banner.describe(connection.lastConnectedAt ?? null, REACH_NOW);
  return (
    <main className="min-h-screen bg-background px-6 py-10" data-reach-banner={state}>
      <div className="mx-auto max-w-3xl">
        <ComposerBannerStack
          items={[
            {
              id: "environment-unavailable:m1",
              variant: banner.variant,
              icon: banner.calm ? <HourglassIcon /> : <WifiOffIcon />,
              title: banner.title,
              description: description || undefined,
              actionsLayout: "wrap-below",
              actions: banner.status.retryable ? (
                <Button size="xs" variant="ghost">
                  Retry
                </Button>
              ) : undefined,
            },
          ]}
        />
        <div className="mt-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          Ask the thread on Build Mac…
        </div>
      </div>
    </main>
  );
}
