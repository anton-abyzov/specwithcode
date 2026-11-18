import type { ComponentType, CSSProperties, ReactNode, SVGProps } from "react";

import type { AccessRowId } from "../../onboarding/accessRows.logic";
import {
  BrowserRowGlyph,
  FolderRowGlyph,
  MacAppsRowGlyph,
  PhoneRowGlyph,
  TerminalRowGlyph,
} from "./AccessRow";

export type StepPictureStep = "connect" | "agents" | "access" | "projects";

/**
 * What each picture reacts to. A key in `lit` draws its thread once.
 * - connect: `machine` (another machine joined), `phone` (the phone joined)
 * - agents: `review` (a reviewer is ready: work passes to review and back)
 * - access: the Access row ids that are allowed or set up
 * - projects: `picked` (folders were picked and become projects)
 */
export const STEP_PICTURE_KEYS = {
  connect: ["machine", "phone"],
  agents: ["review"],
  access: ["files", "browser", "mac-apps", "iphone", "full-disk-access"],
  projects: ["picked"],
} as const satisfies Record<StepPictureStep, readonly string[]>;

const ACCESS_GLYPHS: Record<AccessRowId, ComponentType<Omit<SVGProps<SVGSVGElement>, "ref">>> = {
  files: TerminalRowGlyph,
  browser: BrowserRowGlyph,
  "mac-apps": MacAppsRowGlyph,
  iphone: PhoneRowGlyph,
  "full-disk-access": FolderRowGlyph,
};

/**
 * One picture per first-run step, drawn beside or above the step by
 * `FirstRunFrame`: machines joining one thread (Sign in), work passing to
 * review and back (Agents), a thread pulling tight from the agent to each
 * thing it may use (Access), folders becoming cards (Projects). Inline SVG in
 * theme colors, no text, hidden from assistive technology. Nothing loops: a
 * thread draws once when its key joins `lit`, and one already lit when the
 * picture appears is simply drawn.
 */
export function StepPicture({
  step,
  lit = [],
  rows,
}: {
  readonly step: StepPictureStep;
  /** Keys from `STEP_PICTURE_KEYS[step]` that are done. */
  readonly lit?: readonly string[] | undefined;
  /** Access only: the rows the step lists, in order. Defaults to all five. */
  readonly rows?: readonly AccessRowId[] | undefined;
}) {
  const on = (key: string) => lit.includes(key);
  switch (step) {
    case "connect":
      return <ConnectPicture on={on} />;
    case "agents":
      return <AgentsPicture on={on} />;
    case "access":
      return <AccessPicture on={on} rows={rows ?? STEP_PICTURE_KEYS.access} />;
    case "projects":
      return <ProjectsPicture on={on} />;
  }
}

type Lit = (key: string) => boolean;

function Picture({
  step,
  viewBox,
  children,
}: {
  readonly step: StepPictureStep;
  readonly viewBox: string;
  readonly children: ReactNode;
}) {
  return (
    <svg
      viewBox={viewBox}
      aria-hidden
      focusable="false"
      data-slot="step-picture"
      data-step-picture={step}
    >
      {children}
    </svg>
  );
}

/** A thread that draws once when `lit` turns on. */
function Thread({
  id,
  d,
  lit,
  delayMs,
}: {
  readonly id: string;
  readonly d: string;
  readonly lit: boolean;
  readonly delayMs?: number | undefined;
}) {
  return (
    <path
      d={d}
      pathLength={1}
      data-setup-thread={id}
      data-lit={lit ? "" : undefined}
      data-motion="setup"
      style={delayMs ? ({ transitionDelay: `${delayMs}ms` } as CSSProperties) : undefined}
    />
  );
}

/** The loose line a thread replaces: it goes when the thread is drawn. */
function Slack({ id, d, lit }: { readonly id: string; readonly d: string; readonly lit: boolean }) {
  return <path d={d} data-setup-slack={id} data-lit={lit ? "" : undefined} data-motion="setup" />;
}

/** A mark drawn twice: quiet, and in the accent over it while `lit`. */
function Lights({
  id,
  lit,
  children,
}: {
  readonly id: string;
  readonly lit: boolean;
  readonly children: ReactNode;
}) {
  return (
    <>
      <g>{children}</g>
      <g data-setup-glow={id} data-lit={lit ? "" : undefined} data-motion="setup">
        {children}
      </g>
    </>
  );
}

/** Sign in: this machine, and the machines and the phone that join it. */
function ConnectPicture({ on }: { readonly on: Lit }) {
  return (
    <Picture step="connect" viewBox="0 0 200 200">
      <g data-setup-mark="">
        <rect x="18" y="112" width="74" height="48" rx="6" />
        <path d="M10 168h90" />
      </g>
      <Lights id="machine" lit={on("machine")}>
        <rect x="112" y="22" width="70" height="46" rx="6" />
        <path d="M147 68v11M133 81h28" />
      </Lights>
      <Lights id="phone" lit={on("phone")}>
        <rect x="140" y="112" width="30" height="56" rx="7" />
      </Lights>
      <Slack id="machine" lit={on("machine")} d="M55 112C60 92 96 70 112 46" />
      <Thread id="machine" lit={on("machine")} d="M55 112C55 70 96 52 112 46" />
      <Slack id="phone" lit={on("phone")} d="M92 138C108 150 124 156 140 140" />
      <Thread id="phone" lit={on("phone")} d="M92 138C108 132 124 146 140 140" />
    </Picture>
  );
}

/** Agents: work goes to a reviewer and comes back. */
function AgentsPicture({ on }: { readonly on: Lit }) {
  return (
    <Picture step="agents" viewBox="0 0 200 124">
      <circle cx="56" cy="62" r="20" data-setup-mark="" fill="currentColor" stroke="currentColor" />
      <Lights id="review" lit={on("review")}>
        <circle cx="146" cy="62" r="20" />
        <path d="M138 62l6 6 11-12" />
      </Lights>
      <Thread id="review" lit={on("review")} d="M76 56C96 40 108 40 126 56" />
      <Thread id="back" lit={on("review")} d="M126 70C108 86 96 86 76 70" delayMs={350} />
    </Picture>
  );
}

const ACCESS_PITCH = 72;

/** Access: a thread from the agent to each thing it may use, tight once allowed. */
function AccessPicture({ on, rows }: { readonly on: Lit; readonly rows: readonly AccessRowId[] }) {
  const height = ACCESS_PITCH * Math.max(rows.length, 1) + 4;
  const centre = height / 2;
  return (
    <Picture step="access" viewBox={`0 0 200 ${height}`}>
      <svg
        x="6"
        y={centre - 22}
        width="44"
        height="44"
        viewBox="0 0 24 24"
        data-setup-mark=""
        data-setup-agent=""
      >
        <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
        <path d="M9 9.5l3 2.5-3 2.5M13.5 14.5H16" />
      </svg>
      {rows.map((id, index) => {
        const target = 38 + ACCESS_PITCH * index;
        const lit = on(id);
        const Glyph = ACCESS_GLYPHS[id];
        return (
          <g key={id} data-setup-access-row={id}>
            <Slack
              id={id}
              lit={lit}
              d={`M50 ${centre}C92 ${centre + 30} 118 ${target + 28} 152 ${target}`}
            />
            <Thread
              id={id}
              lit={lit}
              d={`M50 ${centre}C84 ${centre + (target - centre) / 3} 118 ${centre + ((target - centre) * 2) / 3} 152 ${target}`}
            />
            <Lights id={id} lit={lit}>
              <Glyph x={152} y={target - 20} width={40} height={40} />
            </Lights>
          </g>
        );
      })}
    </Picture>
  );
}

/** Projects: picked folders become cards on one board. */
function ProjectsPicture({ on }: { readonly on: Lit }) {
  return (
    <Picture step="projects" viewBox="0 0 200 170">
      <path d="M16 40h22l6 7h30v34H16z" />
      <path d="M16 104h22l6 7h30v34H16z" />
      <Slack id="picked" lit={on("picked")} d="M74 62C100 72 100 94 124 84" />
      <Thread id="picked" lit={on("picked")} d="M74 62C100 62 100 84 124 84" />
      <Slack id="picked-2" lit={on("picked")} d="M74 126C100 136 100 106 124 92" />
      <Thread id="picked-2" lit={on("picked")} d="M74 126C100 126 100 96 124 92" delayMs={80} />
      <Lights id="picked" lit={on("picked")}>
        <rect x="124" y="46" width="62" height="84" rx="8" />
        <path d="M124 74h62M124 102h62" />
      </Lights>
    </Picture>
  );
}
