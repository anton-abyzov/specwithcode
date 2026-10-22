// Synthetic data only: no server, account, provider, network or store.
// ?theme=light|dark  ?scene=settings|review-weave|review-acme|review-conflict|code|figma-off|figma-connected|tokens-file|describe|picker
import type { DesignSystemId, DesignSystemProposal } from "@specweave-studio/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { DesignSystemPickerView } from "../../src/components/design/systems/DesignSystemPicker";
import { DesignSystemReviewDialog } from "../../src/components/design/systems/DesignSystemReviewDialog";
import { DesignSystemsSettingsView } from "../../src/components/design/systems/DesignSystemsSettingsView";
import {
  NewDesignSystemDialog,
  type NewSystemMode,
} from "../../src/components/design/systems/NewDesignSystemDialog";
import { ToastProvider } from "../../src/components/ui/toast";
import { WorkspacePageContainer } from "../../src/components/WorkspacePageContainer";
import {
  ACME_PROPOSAL,
  FIGMA_CONNECTED,
  FIGMA_OFF,
  NOW,
  PROJECTS,
  PROPOSALS,
  SCAN_RESULT,
  SYSTEMS,
  WEAVE_PROPOSAL,
} from "../../src/components/design/systems/fixtureData";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const scene = params.get("scene") ?? "settings";
document.documentElement.classList.toggle("dark", dark);

const calls: Array<{ label: string; value: unknown }> = [];
const record = (label: string, value: unknown) => calls.push({ label, value });
Object.assign(window, { __fixture: { calls } });

const REVIEWS: Record<string, { proposal: DesignSystemProposal; owner: string; error?: string }> = {
  "review-weave": { proposal: WEAVE_PROPOSAL, owner: "Atlas web" },
  "review-acme": { proposal: ACME_PROPOSAL, owner: "Borealis API" },
  "review-conflict": {
    proposal: WEAVE_PROPOSAL,
    owner: "Atlas web",
    error:
      "This design system changed after the proposal was made (it is now at revision 5). Discard this proposal and rescan or import again to review the latest version.",
  },
};

const DIALOG_MODES: Record<string, NewSystemMode> = {
  code: "code",
  "figma-off": "figma",
  "figma-connected": "figma",
  "tokens-file": "tokens-file",
  describe: "describe",
};

function SettingsPage() {
  const [mode, setMode] = useState<NewSystemMode | null>(DIALOG_MODES[scene] ?? null);
  return (
    <div className="h-dvh overflow-auto bg-background text-foreground">
      <WorkspacePageContainer className="gap-8">
        <h1 className="px-3 text-lg font-medium sm:px-4">Design systems</h1>
        <DesignSystemsSettingsView
          systems={SYSTEMS}
          systemsError={null}
          problems={[]}
          proposals={PROPOSALS}
          projects={PROJECTS}
          now={NOW}
          canWrite
          rescans={{ "p:atlas-web:app-theme": { status: "unchanged" } }}
          threadTitleFor={() => "Moodboard for the launch"}
          onRescan={(system) => record("rescan", system.ref.systemId)}
          onOpenProposal={(proposal) => record("open", proposal.id)}
          onNew={(next) => {
            record("new", next);
            setMode(next);
          }}
        />
      </WorkspacePageContainer>
      {mode !== null ? (
        <NewDesignSystemDialog
          mode={mode}
          onModeChange={setMode}
          onOpenChange={(open) => !open && setMode(null)}
          projects={PROJECTS}
          figma={{
            status: scene === "figma-connected" ? FIGMA_CONNECTED : FIGMA_OFF,
            error: null,
            checking: false,
            onCheck: () => record("figmaCheck", null),
          }}
          onScan={async (projectId) => {
            record("scan", projectId);
            return { ok: true, result: SCAN_RESULT };
          }}
          onPropose={async (input) => {
            record("propose", input);
            return null;
          }}
        />
      ) : null}
    </div>
  );
}

function ReviewPage() {
  const review = REVIEWS[scene]!;
  return (
    <div className="h-dvh bg-background">
      <DesignSystemReviewDialog
        proposal={review.proposal}
        loadError={null}
        ownerLabel={review.owner}
        threadTitle={null}
        busy={false}
        error={review.error ?? null}
        onConfirm={(input) => record("confirm", input)}
        onDiscard={() => record("discard", null)}
        onClose={() => record("close", null)}
      />
    </div>
  );
}

function PickerPage() {
  const [value, setValue] = useState<DesignSystemId | null>(null);
  return (
    <div className="h-dvh bg-background p-10 text-foreground">
      <div className="flex w-80 flex-col gap-1.5 rounded-xl border border-border/60 bg-card/40 p-4">
        <label htmlFor="picker" className="text-sm font-medium">
          Design system
        </label>
        <DesignSystemPickerView
          id="picker"
          owner={{ kind: "playground" }}
          systems={SYSTEMS}
          projects={PROJECTS}
          value={value}
          onChange={(next) => {
            record("change", next);
            setValue(next);
          }}
          onCopy={async (system) => {
            record("copy", system.ref.systemId);
            return {
              ok: true,
              systemId: `${system.ref.systemId}-copy` as DesignSystemId,
              name: system.name,
            };
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    {scene in REVIEWS ? <ReviewPage /> : scene === "picker" ? <PickerPage /> : <SettingsPage />}
  </ToastProvider>,
);
