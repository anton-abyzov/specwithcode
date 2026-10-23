import { createRoot } from "react-dom/client";
import { ModelPickerContent } from "../../src/components/chat/ModelPickerContent";
import { ProviderInstanceId, ProviderDriverKind } from "@specweave-studio/contracts";
import { deriveProviderInstanceEntries } from "../../src/providerInstances";
import { HarnessDescription } from "../../src/components/chat/HarnessDescription";
import type { ProviderInstanceEntry } from "../../src/providerInstances";
import "../provider-usability/fixture.css";
const pickerEntry = deriveProviderInstanceEntries([
  {
    instanceId: ProviderInstanceId.make("opencode"),
    driver: ProviderDriverKind.make("opencode"),
    displayName: "OpenCode work",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "unknown" },
    version: "fixture",
    checkedAt: "2026-10-23T00:00:00.000Z",
    models: [
      {
        slug: "fixture/model",
        name: "Local fixture",
        isCustom: false,
        capabilities: null,
        billing: "local",
        toolCalls: true,
        imageInput: false,
        contextWindow: 128000,
      },
    ],
    slashCommands: [],
    skills: [],
  },
])[0]!;
const base = {
  enabled: true,
  installed: true,
  status: "ready",
  isAvailable: true,
  snapshot: {},
  models: [],
};
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-lg space-y-6 p-3 sm:p-8">
    <h1 className="text-xl font-semibold">Choose a harness, then a model</h1>
    <p className="text-sm text-muted-foreground">
      Isolated component fixture. No account is connected.
    </p>
    <div style={{ width: 360 }} className="rounded-lg border" data-real-picker>
      <ModelPickerContent
        activeInstanceId={pickerEntry.instanceId}
        model="fixture/model"
        lockedProvider={null}
        instanceEntries={[pickerEntry]}
        modelOptionsByInstance={new Map([[pickerEntry.instanceId, pickerEntry.models]])}
        terminalOpen={false}
        onInstanceModelChange={() => {}}
      />
    </div>
    {[
      {
        ...base,
        instanceId: "work-opencode",
        driverKind: "opencode",
        displayName: "OpenCode work",
      },
      {
        ...base,
        instanceId: "personal-pi",
        driverKind: "pi",
        displayName: "Private Pi",
        enabled: false,
        installed: false,
      },
      {
        ...base,
        instanceId: "copilot-work",
        driverKind: "acpRegistry",
        displayName: "Copilot work",
      },
    ].map((entry) => (
      <section className="rounded-lg border" key={entry.instanceId}>
        <div className="px-3 py-2 text-sm font-medium">{entry.displayName}</div>
        <HarnessDescription entry={entry as ProviderInstanceEntry} />
        <p className="px-3 py-3 text-sm text-muted-foreground">Model list appears here</p>
      </section>
    ))}
  </main>,
);
