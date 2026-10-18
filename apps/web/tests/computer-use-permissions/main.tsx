// Synthetic data only: a fake desktop bridge, no server, account, provider or store.
import type { ComputerUsePermission, ComputerUsePermissions } from "@specweave-studio/contracts";
import { EnvironmentId } from "@specweave-studio/contracts";
import { MonitorIcon } from "lucide-react";
import { createRoot } from "react-dom/client";

import { ComposerBannerStack } from "../../src/components/chat/ComposerBannerStack";
import {
  COMPUTER_USE_PERMISSION_COPY,
  ComputerUseConnectionNote,
  ComputerUsePermissionCard,
  ComputerUsePermissionSetup,
  ComputerUsePermissionWaitNotice,
  ComputerUseRetryContext,
} from "../../src/components/computerUse/ComputerUsePermissions";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const status: ComputerUsePermissions = { screenRecording: false, accessibility: false };
const calls: string[] = [];
Object.assign(window, {
  __calls: calls,
  __grant: (permission: ComputerUsePermission) => {
    status[COMPUTER_USE_PERMISSION_COPY[permission].key] = true;
  },
  desktopBridge: {
    getComputerUsePermissions: async () => ({ ...status }),
    requestComputerUsePermission: async (permission: ComputerUsePermission) => {
      calls.push(`request:${permission}`);
      return { ...status };
    },
    relaunchForComputerUse: async () => {
      calls.push("relaunch");
    },
  },
});

const local = EnvironmentId.make("m4");
const remote = EnvironmentId.make("m1");
const waiting = COMPUTER_USE_PERMISSION_COPY["screen-recording"].title;

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section data-case={id} className="space-y-2">
      <h2 className="text-xs font-medium text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-2xl space-y-8 p-4">
    <Section id="composer" title="Composer while an action waits">
      <ComposerBannerStack
        items={[
          {
            id: "computer-use-permission:fixture",
            variant: "warning",
            priority: "urgent",
            icon: <MonitorIcon />,
            title: `The agent is waiting for ${waiting}`,
            description: `Allow ${waiting} for SpecWithCode and its action continues by itself.`,
            children: <ComputerUsePermissionWaitNotice permission="screen-recording" />,
          },
        ]}
      />
    </Section>
    <Section id="failed" title="Under a failed computer_screenshot">
      <ComputerUseRetryContext value={(text) => calls.push(`retry:${text}`)}>
        <ComputerUsePermissionCard permission="screen-recording" environmentId={local} />
      </ComputerUseRetryContext>
    </Section>
    <Section id="remote" title="Thread on another Mac">
      <ComputerUsePermissionCard permission="accessibility" environmentId={remote} />
    </Section>
    <Section id="settings" title="Settings › Agent computer access">
      <ComputerUsePermissionSetup environmentId={local} />
    </Section>
    <Section id="connections" title="Connections › computer-use">
      <ComputerUseConnectionNote environmentId={local} />
    </Section>
  </main>,
);
