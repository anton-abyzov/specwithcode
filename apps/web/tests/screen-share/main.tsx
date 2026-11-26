// Synthetic data only: made-up devices and sessions, a picture drawn in the page.
// No server, socket, device key or real screen is involved.
import {
  SCREEN_SHARE_RECORD,
  type ScreenShareLocalState,
  type ScreenShareSessionState,
} from "@specweave-studio/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ScreenShareSettingsView } from "../../src/components/screenShare/ScreenShareSettings";
import {
  ScreenViewerView,
  paintScreenPointer,
} from "../../src/components/screenShare/ScreenViewer";
import {
  initialScreenViewer,
  reduceScreenViewer,
  type ScreenViewerEvent,
  type ScreenViewerModel,
} from "../../src/components/screenShare/screenViewer.logic";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const NOW = Date.now();
const CODE = "482913";
const MACHINE = "Mac Studio";
const calls: string[] = [];
const sent: Array<Record<string, unknown>> = [];
Object.assign(window, { __calls: calls, __sent: sent });

const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const SHARING: ScreenShareLocalState = {
  supported: true,
  enabled: true,
  link: "attached",
  screenRecording: true,
  storeHealthy: true,
  storeWritable: true,
  grants: [
    {
      thumbprint: "thumb-laptop",
      label: "Work laptop",
      shortId: "7F3A",
      grantedAt: ago(3 * 24 * 60),
      lastUsedAt: ago(42),
    },
  ],
  audit: [
    {
      id: "s4",
      at: ago(42),
      label: "Work laptop",
      shortId: "7F3A",
      mode: "view",
      outcome: "allowed_by_grant",
      startedAt: ago(42),
      endedAt: ago(30),
      reason: "viewer_ended",
      frames: 512,
    },
    {
      id: "s3",
      at: ago(95),
      label: "Phone",
      shortId: "H4WN",
      mode: "view",
      outcome: "allowed_once",
      startedAt: ago(95),
      endedAt: ago(90),
      reason: "stopped_at_machine",
      frames: 61,
    },
    {
      id: "s2",
      at: ago(26 * 60),
      label: "Phone",
      shortId: "H4WN",
      mode: "view",
      outcome: "refused",
      endedAt: ago(26 * 60),
      reason: "prompt_timeout",
    },
    {
      id: "s1",
      at: ago(3 * 24 * 60),
      label: "Work laptop",
      shortId: "7F3A",
      mode: "view",
      outcome: "allowed_always",
      startedAt: ago(3 * 24 * 60),
      endedAt: ago(3 * 24 * 60 - 12),
      reason: "viewer_ended",
      frames: 240,
    },
  ],
  active: null,
};

const TROUBLED: ScreenShareLocalState = {
  ...SHARING,
  link: "replaced",
  screenRecording: false,
  storeHealthy: false,
  storeWritable: false,
  grants: [],
  audit: [],
  active: { label: "Work laptop", shortId: "7F3A", startedAt: ago(4) },
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-case={id} className="space-y-2">
      <h2 className="text-xs font-medium text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  );
}

/** The settings block over a stand-in for the app's main process. */
function Settings({ initial }: { initial: ScreenShareLocalState }) {
  const [state, setState] = useState(initial);
  return (
    <ScreenShareSettingsView
      place="here"
      state={state}
      busy={false}
      onSetEnabled={(enabled) => {
        calls.push(`enabled:${enabled}`);
        setState((current) => ({ ...current, enabled, active: enabled ? current.active : null }));
      }}
      onRemoveGrant={(thumbprint) => {
        calls.push(`remove:${thumbprint}`);
        setState((current) => ({
          ...current,
          grants: current.grants.filter((grant) => grant.thumbprint !== thumbprint),
        }));
      }}
    />
  );
}

const encoder = new TextEncoder();
const state = (value: ScreenShareSessionState): ScreenViewerEvent => ({
  t: "record",
  type: SCREEN_SHARE_RECORD.state,
  data: encoder.encode(JSON.stringify(value)),
  now: NOW,
});
const LIVE: ScreenShareSessionState = {
  phase: "live",
  displays: [
    { id: "1", label: "Built-in display", primary: true },
    { id: "2", label: "Studio Display", primary: false },
  ],
  displayId: "1",
  endsAt: NOW + 2 * 60 * 60_000 - 30_000,
};

const through = (events: ReadonlyArray<ScreenViewerEvent>): ScreenViewerModel =>
  events.reduce((model, event) => reduceScreenViewer(model, event).model, initialScreenViewer(NOW));

/** A made-up desktop, drawn here: a menu bar, two windows and a line of text. */
function drawTestPicture(canvas: HTMLCanvasElement): void {
  canvas.width = 1280;
  canvas.height = 800;
  const context = canvas.getContext("2d");
  if (context === null) return;
  const sky = context.createLinearGradient(0, 0, 1280, 800);
  sky.addColorStop(0, "#27496d");
  sky.addColorStop(1, "#7a5c8f");
  context.fillStyle = sky;
  context.fillRect(0, 0, 1280, 800);
  context.fillStyle = "rgba(255, 255, 255, 0.82)";
  context.fillRect(0, 0, 1280, 28);
  const windowAt = (x: number, y: number, width: number, height: number, title: string) => {
    context.fillStyle = "#f4f4f5";
    context.fillRect(x, y, width, height);
    context.fillStyle = "#d4d4d8";
    context.fillRect(x, y, width, 32);
    context.fillStyle = "#3f3f46";
    context.font = "15px sans-serif";
    context.fillText(title, x + 16, y + 21);
    context.fillStyle = "#a1a1aa";
    for (let line = 0; line < 9; line += 1)
      context.fillRect(x + 20, y + 56 + line * 26, width * (0.4 + ((line * 37) % 50) / 100), 10);
  };
  windowAt(90, 90, 620, 420, "Notes");
  windowAt(560, 300, 600, 400, "Terminal");
  context.fillStyle = "#18181b";
  context.font = "600 20px sans-serif";
  context.fillText("Test picture, drawn in the fixture", 120, 470);
  paintScreenPointer(canvas, { x: 820, y: 520 });
}

/** One viewer state in a framed box, run by the real rules. */
function Viewer({ initial, picture = false }: { initial: ScreenViewerModel; picture?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [model, setModel] = useState(initial);
  const apply = (event: ScreenViewerEvent) =>
    setModel((current) => {
      const step = reduceScreenViewer(current, event);
      for (const effect of step.effects)
        if (effect.t === "send") sent.push({ type: effect.type, ...effect.body });
      return step.model;
    });
  useEffect(() => {
    if (picture && canvasRef.current) drawTestPicture(canvasRef.current);
  }, [picture]);
  return (
    <div className="flex h-[440px] flex-col overflow-hidden rounded-xl border border-border bg-background">
      <ScreenViewerView
        machine={MACHINE}
        model={model}
        now={NOW}
        canvasRef={canvasRef}
        onTypedCode={(text) => apply({ t: "typed_code", text })}
        onChooseDisplay={(displayId) => apply({ t: "choose_display", displayId })}
        onEnd={() => apply({ t: "end_here" })}
        onClose={() => calls.push("close")}
        onRetry={() => calls.push("retry")}
        onForgetKey={() => calls.push("forget-key")}
      />
    </div>
  );
}

const known: ScreenViewerEvent = { t: "handshake", code: CODE, machineKey: "key", pinned: true };
const fresh: ScreenViewerEvent = { t: "handshake", code: CODE, machineKey: "key", pinned: false };
const waiting = through([fresh, state({ phase: "waiting_for_approval" })]);
const code = through([
  fresh,
  state({ phase: "waiting_for_approval" }),
  state({ phase: "needs_code", triesLeft: 3 }),
]);
const live = { ...through([known, state(LIVE)]), hasPicture: true };
const locked = through([known, state(LIVE), state({ phase: "locked" })]);
const keyChanged = through([{ t: "handshake_failed", failure: "machine_key_changed" }]);
const off = through([{ t: "closed", code: 4460, reason: "off", opened: true }]);

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="mx-auto max-w-4xl space-y-8 p-4">
      <Section id="settings" title="This machine, sharing on">
        <Settings initial={SHARING} />
      </Section>
      <Section id="notices" title="This machine, with things to fix and a device viewing">
        <Settings initial={TROUBLED} />
      </Section>
      <Section id="elsewhere" title="A browser tab or another machine's page">
        <ScreenShareSettingsView
          place="elsewhere"
          state={null}
          busy={false}
          onSetEnabled={() => calls.push("enabled:elsewhere")}
          onRemoveGrant={() => calls.push("remove:elsewhere")}
        />
      </Section>
      <Section id="waiting" title="Viewer: waiting for someone at the machine">
        <Viewer initial={waiting} />
      </Section>
      <Section id="code" title="Viewer: first use, the code from the machine's screen">
        <Viewer initial={code} />
      </Section>
      <Section id="live" title="Viewer: live, view only">
        <Viewer initial={live} picture />
      </Section>
      <Section id="locked" title="Viewer: the machine is locked">
        <Viewer initial={locked} />
      </Section>
      <Section id="key-changed" title="Viewer: the machine answered with another key">
        <Viewer initial={keyChanged} />
      </Section>
      <Section id="off" title="Viewer: sharing is off on that machine">
        <Viewer initial={off} />
      </Section>
    </main>
  </TooltipProvider>,
);
