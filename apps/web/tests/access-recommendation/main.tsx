// The first-run Access step in the real setup frame, and the composer's access
// chip with its callout, over fixture answers. Query:
//   ?view=wizard|composer   which surface
//   ?theme=light|dark
//   ?save=fails             saving Full access fails after a moment
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AccessStep } from "../../src/components/onboarding/AccessStep";
import { FirstRunFrame, shownStages } from "../../src/components/onboarding/WizardFrame";
import { AccessRecommendationAnchor } from "../../src/components/chat/AccessRecommendation";
import { FullAccessGlyph, SupervisedAccessGlyph } from "../../src/components/chat/AccessGlyph";
import { en } from "../../src/i18n/messages/en";
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

function Wizard() {
  const stages = shownStages([
    { id: "connect", label: "Sign in" },
    { id: "agents", label: "Agents" },
    { id: "access", label: "Access" },
    { id: "projects", label: "Projects" },
  ]);
  const [done, setDone] = useState<string | null>(null);
  return (
    <FirstRunFrame
      stages={stages}
      currentStage={done ? 3 : 2}
      onStageChange={(stage) => calls.push(["stage", stage.id])}
      canClose
      onLeave={() => calls.push(["leave"])}
    >
      {done ? (
        <p data-fixture-done={done}>Projects</p>
      ) : (
        <AccessStep
          keepsSupervised
          onBack={() => calls.push(["back"])}
          onAccept={async () => {
            const error = await save("accept");
            if (error === null) setDone("accepted");
            return error;
          }}
          onDecline={async () => {
            calls.push(["decline"]);
            setDone("declined");
            return null;
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
