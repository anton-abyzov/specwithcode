import { ProviderInstanceId } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";
import { HostLimits } from "../../src/components/studio/shell/HostLimits";
import {
  ProjectUsageIndicator,
  SubscriptionUsageSummary,
} from "../../src/components/studio/shell/ProjectUsageIndicator";
import { UsageLimitsSection } from "../../src/components/usage/UsageLimits";
import { applyThemePalette } from "../../src/themePalette";
import { projectHost } from "./mocks";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
document.body.style.backgroundColor = dark ? "#1f1f1f" : "#fafafa";

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 p-4 sm:p-8">
    <section data-surface="pill" className="pt-[30rem]">
      <ProjectUsageIndicator
        onOpenProjectUsage={() => {}}
        projectEnvironmentId={projectHost}
        providerInstanceId={ProviderInstanceId.make("claudeAgent")}
      />
    </section>
    <section data-surface="settings" className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Project settings · Usage</h1>
      <SubscriptionUsageSummary />
      <HostLimits projectEnvironmentId={projectHost} pooled={null} />
    </section>
    <section data-surface="limits">
      <h1 className="mb-4 text-lg font-semibold">Usage · Limits</h1>
      <UsageLimitsSection selectedEnvironmentIds={null} now={Date.now()} />
    </section>
  </main>,
);
