// The first-run frame with every step's picture, the real Access step and a
// busy step, for motion.mjs (?fixture=motion). Setup itself draws the pictures
// once WelcomeWizard passes them; until then this is where they are checked.
// Hooks for the checks: window.fixtureRelease() ends the busy step.
import { useState } from "react";

import {
  AccessRow,
  AccessRowAction,
  AccessRowChip,
  BrowserRowGlyph,
  MacAppsRowGlyph,
  PhoneRowGlyph,
} from "../../src/components/onboarding/AccessRow";
import { AccessStep, type FilesAnswer } from "../../src/components/onboarding/AccessStep";
import { StepPicture } from "../../src/components/onboarding/StepPicture";
import {
  FirstRunFrame,
  StepShell,
  WizardStepFooter,
  stageAfter,
  stageBefore,
  type WizardStage,
} from "../../src/components/onboarding/WizardFrame";
import { useT } from "../../src/i18n";
import type { AccessRowId } from "../../src/onboarding/accessRows.logic";

type Stage = "connect" | "agents" | "access" | "projects";
const ROWS: readonly { id: AccessRowId; machineIds: readonly string[] }[] = [
  { id: "files", machineIds: ["this-mac"] },
  { id: "browser", machineIds: ["this-mac"] },
  { id: "mac-apps", machineIds: ["this-mac"] },
  { id: "iphone", machineIds: ["this-mac"] },
];

export function MotionFixture() {
  const t = useT();
  const stages: readonly WizardStage<Stage>[] = [
    { id: "connect", label: t("wizard.stage.connect") },
    { id: "agents", label: t("wizard.stage.agents") },
    { id: "access", label: t("wizard.stage.access") },
    { id: "projects", label: t("wizard.stage.projects") },
  ];
  const [stage, setStage] = useState<Stage>("connect");
  const [lit, setLit] = useState<Record<Stage, readonly string[]>>({
    connect: [],
    agents: [],
    access: [],
    projects: [],
  });
  // The Agents step is busy the first time it opens, until the check releases it.
  const [busy, setBusy] = useState(true);
  Object.assign(window, { fixtureRelease: () => setBusy(false) });
  const [files, setFiles] = useState<FilesAnswer>(null);
  const light = (key: string) =>
    setLit((current) => ({
      ...current,
      [stage]: current[stage].includes(key) ? current[stage] : [...current[stage], key],
    }));
  const next = () => setStage((current) => stageAfter(stages, current) ?? current);
  const back = () => setStage((current) => stageBefore(stages, current) ?? current);
  const index = stages.findIndex((entry) => entry.id === stage);

  return (
    <FirstRunFrame
      stepId={stage}
      stages={stages}
      currentStage={index}
      onStageChange={(picked) => setStage(picked.id)}
      canClose={false}
      onLeave={() => {}}
      picture={
        <StepPicture
          step={stage}
          lit={lit[stage]}
          rows={stage === "access" ? ROWS.map((row) => row.id) : undefined}
        />
      }
    >
      {stage === "connect" ? (
        <StepShell title="Sign in" description="Link this machine, then the others join it.">
          <div className="mt-4 flex flex-wrap gap-2">
            <AccessRowAction data-fixture-light="machine" onClick={() => light("machine")}>
              Link another machine
            </AccessRowAction>
          </div>
          <WizardStepFooter
            primary={{ label: t("wizard.continue"), onClick: next, neutral: true }}
          />
        </StepShell>
      ) : stage === "agents" ? (
        <StepShell title="Agents" description="One agent ready is enough to go on.">
          <div className="mt-4">
            <AccessRowAction data-fixture-light="review" onClick={() => light("review")}>
              Add a reviewer
            </AccessRowAction>
          </div>
          <WizardStepFooter
            back={{ onClick: back }}
            primary={{
              label: busy ? "Checking agents" : t("wizard.continue"),
              onClick: next,
              busy,
              neutral: true,
            }}
          />
        </StepShell>
      ) : stage === "access" ? (
        <AccessStep
          title="What agents can use on this Mac"
          rows={ROWS}
          files={{
            machineNames: ["This Mac"],
            keepsSupervised: true,
            answer: files,
            onAccept: async () => {
              setFiles("accepted");
              light("files");
              return null;
            },
            onKeep: async () => {
              setFiles("declined");
              return null;
            },
          }}
          renderRow={(id, open) => (
            <FixtureRow id={id} open={open} lit={lit.access.includes(id)} light={light} />
          )}
          onBack={back}
          onContinue={next}
        />
      ) : (
        <StepShell title="Projects" description="Pick folders to bring in.">
          <div className="mt-4">
            <AccessRowAction data-fixture-light="picked" onClick={() => light("picked")}>
              Pick folders
            </AccessRowAction>
          </div>
          <WizardStepFooter
            back={{ onClick: back }}
            primary={{ label: t("wizard.continue"), onClick: () => {}, neutral: true }}
          />
        </StepShell>
      )}
    </FirstRunFrame>
  );
}

function FixtureRow({
  id,
  open,
  lit,
  light,
}: {
  readonly id: AccessRowId;
  readonly open: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void };
  readonly lit: boolean;
  readonly light: (key: string) => void;
}) {
  const glyph =
    id === "browser" ? (
      <BrowserRowGlyph />
    ) : id === "mac-apps" ? (
      <MacAppsRowGlyph />
    ) : (
      <PhoneRowGlyph />
    );
  const title = id === "browser" ? "Your browser" : id === "mac-apps" ? "Mac apps" : "Your iPhone";
  const expands = id !== "mac-apps";
  return (
    <AccessRow
      id={id}
      glyph={glyph}
      title={title}
      done={lit}
      state="Agents use it only while you allow it."
      open={open.open}
      actions={
        lit ? (
          <AccessRowChip on>Allowed</AccessRowChip>
        ) : expands ? (
          <AccessRowAction
            data-fixture-open={id}
            expands={{ row: id, open: open.open }}
            onClick={() => open.onOpenChange(!open.open)}
          >
            {open.open ? "Hide" : "Set up"}
          </AccessRowAction>
        ) : (
          <AccessRowAction data-fixture-light={id} onClick={() => light(id)}>
            Allow
          </AccessRowAction>
        )
      }
    >
      <p className="mb-2">Pick the profile, then copy the code into it.</p>
      <p className="mb-2">The pairing ends when you remove it in Settings.</p>
      <AccessRowAction data-fixture-light={id} onClick={() => light(id)}>
        Pair
      </AccessRowAction>
    </AccessRow>
  );
}
