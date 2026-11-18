// The first-run Access step in the real setup frame, and the composer's access
// chip with its callout, over fixture answers. Query:
//   ?view=wizard|composer   which surface
//   ?theme=light|dark
//   ?save=fails             saving Full access fails after a moment
//   ?files=unanswered|before-accepted|before-declined   the Files and commands row
//   ?chrome=<kind>          the Your browser row: a `chromeRowState` kind, or paired-many
//   ?mac=<kind>             the Mac apps row: a `macAppsRowState` kind
//   ?profiles=0|1|3         Chrome profiles the desktop app could list
//   ?fda=0                  leave out the Full Disk Access row
import type { ComputerUsePermissions } from "@specweave-studio/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AccessStep } from "../../src/components/onboarding/AccessStep";
import { ChromeAccessRowView } from "../../src/components/onboarding/ChromeAccessRow";
import {
  macAppsRowState,
  MacAppsRowView,
  type MacAppsRowStateKind,
} from "../../src/components/onboarding/MacAppsRow";
import { ComputerUsePermissionChecklist } from "../../src/components/computerUse/ComputerUsePermissions";
import {
  BrowserExtensionSteps,
  type PairingCodeState,
} from "../../src/components/settings/BrowserExtensionSetup";
import { FirstRunFrame, shownStages } from "../../src/components/onboarding/WizardFrame";
import { StepPicture } from "../../src/components/onboarding/StepPicture";
import { AccessRecommendationAnchor } from "../../src/components/chat/AccessRecommendation";
import { FullAccessGlyph, SupervisedAccessGlyph } from "../../src/components/chat/AccessGlyph";
import { en } from "../../src/i18n/messages/en";
import { chromeRowState, type ChromeRowInput } from "../../src/onboarding/chromeRowState.logic";
import type { AccessRowPlan } from "../../src/onboarding/accessRows.logic";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const fails = params.get("save") === "fails";
const calls: unknown[] = [];
Object.assign(window, { fixtureCalls: calls });
const save = async (what: string) => {
  calls.push([what]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return fails ? en["wizard.access.saveFailed"] : null;
};

const STORE_URL = "https://chromewebstore.google.com/detail/specwithcode-browser/fixture";
const work = { id: "p1", label: "Work", extensionVersion: "1.4.0", fromStore: true };
const CHROME: Record<string, ChromeRowInput> = (() => {
  const base: ChromeRowInput = {
    online: true,
    teamRulesLocked: false,
    allowed: true,
    status: { bundledVersion: "1.4.0", profiles: [] },
    codeHandedOut: false,
  };
  return {
    "not-set-up": base,
    loading: { ...base, status: null },
    offline: { ...base, online: false, status: null },
    "team-rules": { ...base, teamRulesLocked: true },
    "not-allowed": { ...base, allowed: false },
    "chrome-missing": {
      ...base,
      status: { bundledVersion: "1.4.0", profiles: [], chromeInstalled: false },
    },
    waiting: { ...base, codeHandedOut: true },
    paired: { ...base, status: { bundledVersion: "1.4.0", profiles: [work] } },
    "paired-many": {
      ...base,
      status: {
        bundledVersion: "1.4.0",
        profiles: [
          work,
          { id: "p2", label: "Chrome (2)", extensionVersion: "1.3.0", fromStore: false },
        ],
      },
    },
    "not-answering": { ...base, status: { bundledVersion: "1.4.0", profiles: [], paired: true } },
    approval: {
      ...base,
      status: {
        bundledVersion: "1.4.0",
        profiles: [work],
        peers: [{ id: "g1", machine: "Studio", state: "pending" }],
      },
    },
  };
})();
const MAC: Record<
  MacAppsRowStateKind,
  { status: ComputerUsePermissions; error: string | null; requested: boolean }
> = {
  allowed: {
    status: { screenRecording: true, accessibility: true },
    error: null,
    requested: false,
  },
  partly: {
    status: { screenRecording: true, accessibility: false },
    error: null,
    requested: false,
  },
  "not-allowed": {
    status: { screenRecording: false, accessibility: false },
    error: null,
    requested: false,
  },
  "needs-reopening": {
    status: { screenRecording: false, accessibility: true },
    error: null,
    requested: true,
  },
  "could-not-check": {
    status: { screenRecording: false, accessibility: false },
    error: "Could not check permissions. Trying again automatically.",
    requested: false,
  },
};
const PROFILES = [
  { directory: "Default", name: "Personal" },
  { directory: "Profile 1", name: "Work" },
  { directory: "Profile 2", name: "Brand" },
];

function ChromeRow({ open }: { open: { open: boolean; onOpenChange: (open: boolean) => void } }) {
  const given = CHROME[params.get("chrome") ?? "not-set-up"] ?? CHROME["not-set-up"]!;
  const [code, setCode] = useState<PairingCodeState>({ kind: "idle" });
  const [chosen, setChosen] = useState<string | null>("Default");
  const count = Number(params.get("profiles") ?? "0");
  const profiles = count > 0 ? PROFILES.slice(0, count) : null;
  const handedOut = code.kind === "copied" || code.kind === "shown";
  const state = chromeRowState({ ...given, codeHandedOut: given.codeHandedOut || handedOut });
  return (
    <ChromeAccessRowView
      state={state}
      machine="M4 Max"
      {...open}
      storeUrl={STORE_URL}
      onReconnect={() => calls.push(["reconnect"])}
      onAnswer={(allow) => calls.push([allow ? "allow" : "decline-peer"])}
      steps={
        <BrowserExtensionSteps
          profiles={profiles}
          chosen={chosen}
          onChoose={setChosen}
          storeUrl={STORE_URL}
          onAddToChrome={profiles ? () => calls.push(["add-to-chrome", chosen]) : undefined}
          code={code}
          onCopyCode={() => {
            calls.push(["copy"]);
            setCode({ kind: "copied" });
          }}
          onShowCode={() => setCode({ kind: "shown", code: "K7QX-2MZD-94HF" })}
          onHideCode={() => setCode({ kind: "idle" })}
          canPair
          waiting={handedOut || given.codeHandedOut}
        />
      }
    />
  );
}

function MacRow({ open }: { open: { open: boolean; onOpenChange: (open: boolean) => void } }) {
  const kind = (params.get("mac") ?? "not-allowed") as MacAppsRowStateKind;
  const given = MAC[kind] ?? MAC["not-allowed"];
  const state = macAppsRowState({
    status: given.status,
    error: given.error,
    screenRecordingRequested: given.requested,
  });
  const checklistState = {
    available: true,
    status: given.status,
    error: given.error,
    requested: new Set(given.requested ? (["screen-recording"] as const) : []),
    request: (permission: string) => calls.push(["request", permission]),
    resetDone: new Set(),
    resetError: null,
    reset: (permission: string) => calls.push(["reset", permission]),
    relaunch: () => calls.push(["relaunch"]),
    retry: () => calls.push(["retry"]),
  } as unknown as Parameters<typeof ComputerUsePermissionChecklist>[0]["state"];
  return (
    <MacAppsRowView
      state={state}
      {...open}
      onRetry={() => calls.push(["retry"])}
      checklist={<ComputerUsePermissionChecklist state={checklistState} />}
    />
  );
}

function Wizard() {
  const stages = shownStages([
    { id: "connect", label: "Sign in" },
    { id: "agents", label: "Agents" },
    { id: "access", label: "Access" },
    { id: "projects", label: "Projects" },
  ]);
  const [done, setDone] = useState(false);
  const [answer, setAnswer] = useState<"accepted" | "declined" | null>(null);
  const filesParam = params.get("files") ?? "unanswered";
  const rows: AccessRowPlan[] = [
    { id: "files", machineIds: ["m4"] },
    { id: "browser", machineIds: ["m4"] },
    { id: "mac-apps", machineIds: ["m4"] },
    ...(params.get("fda") === "0" ? [] : [{ id: "full-disk-access" as const, machineIds: ["m4"] }]),
  ];
  return (
    <FirstRunFrame
      stepId={done ? "import" : "access"}
      stages={stages}
      currentStage={done ? 3 : 2}
      onStageChange={(stage) => calls.push(["stage", stage.id])}
      canClose
      onLeave={() => calls.push(["leave"])}
      picture={
        <StepPicture
          step={done ? "projects" : "access"}
          lit={[
            ...(answer === "accepted" || filesParam === "before-accepted" ? ["files"] : []),
            ...(params.get("chrome")?.startsWith("paired") ? ["browser"] : []),
            ...(params.get("mac") === "allowed" ? ["mac-apps"] : []),
          ]}
          rows={rows.map((row) => row.id)}
        />
      }
    >
      {done ? (
        <p data-fixture-done={answer ?? "none"}>Projects</p>
      ) : (
        <AccessStep
          title="What agents can use on this Mac"
          rows={rows}
          files={{
            machineNames: ["M4 Max"],
            keepsSupervised: true,
            answer,
            ...(filesParam === "before-accepted"
              ? { answeredBefore: "accepted" as const }
              : filesParam === "before-declined"
                ? { answeredBefore: "declined" as const }
                : {}),
            onAccept: async () => {
              const error = await save("accept");
              if (error === null) setAnswer("accepted");
              return error;
            },
            onKeep: async () => {
              calls.push(["keep"]);
              setAnswer("declined");
              return null;
            },
          }}
          renderRow={(id, open) =>
            id === "browser" ? (
              <ChromeRow open={open} />
            ) : id === "mac-apps" ? (
              <MacRow open={open} />
            ) : null
          }
          onBack={() => calls.push(["back"])}
          onContinue={() => {
            calls.push(["continue"]);
            setDone(true);
          }}
        />
      )}
    </FirstRunFrame>
  );
}

/** A new chat's empty screen around the real chip highlight and callout. */
function Composer() {
  const [answer, setAnswer] = useState<"accepted" | "declined" | null>(null);
  const fullAccess = answer === "accepted";
  const Glyph = fullAccess ? FullAccessGlyph : SupervisedAccessGlyph;
  const chip = (
    <button
      type="button"
      data-runtime-mode={fullAccess ? "full-access" : "approval-required"}
      className={
        fullAccess
          ? "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-warning-foreground"
          : "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground"
      }
    >
      <Glyph aria-hidden className="size-4" />
      {fullAccess ? "Full access" : "Supervised"}
    </button>
  );
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <h1 className="text-center text-3xl font-semibold tracking-tight text-foreground">
        What should we build in demo-app?
      </h1>
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-3 shadow-sm">
        <p className="px-1 pb-8 text-sm text-muted-foreground">Ask for a change, a fix or a plan</p>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="px-1">Claude Sonnet</span>
          <span aria-hidden className="h-4 w-px bg-border" />
          <span className="px-1">Build</span>
          <span aria-hidden className="h-4 w-px bg-border" />
          {answer === null ? (
            <AccessRecommendationAnchor
              mode="approval-required"
              hidden={false}
              recommendation={{
                accept: async () => {
                  const error = await save("accept");
                  if (error === null) setAnswer("accepted");
                  return error;
                },
                decline: () => {
                  calls.push(["decline"]);
                  setAnswer("declined");
                },
              }}
            >
              {chip}
            </AccessRecommendationAnchor>
          ) : (
            chip
          )}
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  params.get("view") === "composer" ? <Composer /> : <Wizard />,
);
