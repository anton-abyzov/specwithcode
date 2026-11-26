/**
 * What the two screen sharing windows on the viewed machine say (1490): the
 * prompt and the banner. Plain strings in, a static page out. The pages run no
 * script of their own; their one preload wires the buttons and the clock.
 *
 * Every name on them came from another device, so everything is escaped.
 */
import type { ScreenShareBannerView, ScreenSharePromptView } from "./screenShareSession.logic.ts";

export const SCREEN_SHARE_PROMPT_SIZE = { width: 460, height: 268 } as const;
export const SCREEN_SHARE_BANNER_SIZE = { width: 520, height: 44 } as const;

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"'`]/g, (character) => `&#${character.charCodeAt(0)};`);

/** A name from another device: one line, no control characters, not too long. */
export const displayName = (value: string): string => {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ");
  const single = cleaned.replace(/\s+/g, " ").trim();
  return single.length > 60 ? `${single.slice(0, 59)}…` : single || "Unnamed device";
};

/** "482913" as "482 913". */
export const formatCode = (code: string): string =>
  code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

const PAGE_STYLE = `
:root { color-scheme: light dark; --base: #fff; --row: #e7e7e7; --text: #292929; --soft: #6b6b6b; --line: #e3e3e3; --accent: #007aff; --warn: #d92d20; }
@media (prefers-color-scheme: dark) { :root { --base: #242424; --row: #383838; --text: #f5f5f5; --soft: #a8a8a8; --line: #484848; --warn: #ff6b5e; } }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body { color: var(--text); font: 14px/20px -apple-system, BlinkMacSystemFont, sans-serif; user-select: none; -webkit-app-region: no-drag; }
button { font: inherit; color: inherit; border: 0; border-radius: 8px; padding: 6px 12px; background: var(--row); cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const page = (title: string, style: string, body: string, data: Record<string, string>) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}${style}</style></head>
<body ${Object.entries(data)
    .map(([name, value]) => `data-${name}="${escapeHtml(value)}"`)
    .join(" ")}>${body}</body></html>`;

export const promptHtml = (view: ScreenSharePromptView): string => {
  const name = escapeHtml(displayName(view.label));
  const id = escapeHtml(view.shortId);
  const claimed =
    view.claimedLabel === undefined
      ? ""
      : `<p class="soft">It now calls itself "${escapeHtml(displayName(view.claimedLabel))}". The name above is the one you approved.</p>`;
  const code =
    view.code === undefined
      ? ""
      : `<p class="soft">${view.stage === "code" ? "Type this code on that device:" : "First time from this device. After you allow, type this code on it:"}</p>
<p id="code" aria-label="Code ${escapeHtml(view.code.split("").join(" "))}">${escapeHtml(formatCode(view.code))}</p>`;
  const actions =
    view.stage === "ask"
      ? `<div id="actions"><button id="deny">Deny</button><span class="gap"></span><button id="once">Allow once</button><button id="always" class="primary">Always allow this device</button></div>
<p class="soft small">Allowing asks for Touch ID or your password. <span id="left"></span></p>`
      : `<div id="actions"><button id="deny">Cancel</button><span class="gap"></span></div>
<p class="soft small">Waiting for the code. <span id="left"></span></p>`;
  return page(
    "Screen sharing request",
    `
#panel { margin: 2px; padding: 18px 20px; height: ${SCREEN_SHARE_PROMPT_SIZE.height - 4}px; border: 1px solid var(--line); border-radius: 16px; background: var(--base); display: flex; flex-direction: column; gap: 6px; }
h1 { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }
p { margin: 0; }
.soft { color: var(--soft); }
.small { font-size: 12px; line-height: 16px; }
#code { font: 600 28px/36px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 2px; }
#actions { display: flex; gap: 8px; margin-top: auto; }
.gap { flex: 1; }
.primary { background: var(--accent); color: #fff; }
`,
    `<main id="panel" role="alertdialog" aria-labelledby="title">
<h1 id="title">${name} (ID ${id}) wants to view this Mac's screen</h1>
<p class="soft">View only. A banner stays on screen while it is viewing, with Stop.</p>
${claimed}${code}${actions}
</main>`,
    { window: "prompt", sid: view.sid, expires: String(view.expiresAt) },
  );
};

export const bannerHtml = (view: ScreenShareBannerView): string =>
  page(
    "Screen sharing",
    `
#bar { margin: 2px; height: ${SCREEN_SHARE_BANNER_SIZE.height - 4}px; padding: 0 8px 0 14px; border-radius: 20px; background: var(--warn); color: #fff; display: flex; align-items: center; gap: 10px; white-space: nowrap; -webkit-app-region: drag; }
#who { overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
#elapsed { font-variant-numeric: tabular-nums; }
.gap { flex: 1; }
#stop { background: #fff; color: #1a1a1a; font-weight: 600; padding: 4px 14px; -webkit-app-region: no-drag; }
`,
    `<main id="bar" role="status">
<span id="who">${escapeHtml(displayName(view.label))} (ID ${escapeHtml(view.shortId)}) is viewing this screen</span>
<span id="elapsed">00:00</span><span class="gap"></span><button id="stop">Stop</button>
</main>`,
    { window: "banner", started: String(view.startedAt) },
  );

export type ScreenShareWindowAction =
  | { readonly window: "prompt"; readonly sid: string; readonly answer: "deny" | "once" | "always" }
  | { readonly window: "banner"; readonly action: "stop" };

/** What a window's preload may send. Anything else is dropped. */
export const parseWindowAction = (value: unknown): ScreenShareWindowAction | null => {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.window === "banner" && message.action === "stop")
    return { window: "banner", action: "stop" };
  if (
    message.window === "prompt" &&
    typeof message.sid === "string" &&
    (message.answer === "deny" || message.answer === "once" || message.answer === "always")
  )
    return { window: "prompt", sid: message.sid, answer: message.answer };
  return null;
};

/** "02:13", or "1:02:13" past the hour. */
export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const two = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const rest = `${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
  return hours > 0 ? `${hours}:${rest}` : rest;
};

/** Top centre of the display's work area, below the menu bar. */
export const bannerPosition = (
  workArea: { readonly x: number; readonly y: number; readonly width: number },
  size: { readonly width: number },
): { readonly x: number; readonly y: number } => ({
  x: Math.round(workArea.x + (workArea.width - size.width) / 2),
  y: workArea.y + 8,
});
