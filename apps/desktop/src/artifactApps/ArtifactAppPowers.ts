/**
 * The pure rules of an installed page's desktop powers: what a page's file
 * declares, which requests are well formed, which accelerators a page may
 * take, and the words the consent dialog uses. Nothing here grants anything;
 * every reader answers "nothing" for input it does not fully understand.
 */
import { ARTIFACT_APP_POWERS, type ArtifactAppPower } from "@specweave-studio/contracts";
import type * as Electron from "electron";

export const ARTIFACT_APP_MANIFEST_TYPE = "application/specwithcode-app+json";
export const ARTIFACT_APP_SHORTCUT_LIMIT = 4;
export const ARTIFACT_APP_TRAY_ITEM_LIMIT = 12;
export const ARTIFACT_APP_NOTIFICATION_LIMIT = 10;
export const ARTIFACT_APP_NOTIFICATION_WINDOW_MS = 60_000;

const MANIFEST_MAX_CHARS = 16_384;
const MANIFEST_MAX_ENTRIES = 64;
const NOTIFICATION_TITLE_MAX = 120;
const NOTIFICATION_BODY_MAX = 500;
const TRAY_TITLE_MAX = 24;
const TRAY_TOOLTIP_MAX = 120;
const TRAY_ITEM_ID_MAX = 64;
const TRAY_ITEM_LABEL_MAX = 80;
const ACCELERATOR_MAX = 64;

const POWERS: ReadonlySet<string> = new Set(ARTIFACT_APP_POWERS);

// The first manifest element in the file. The type must be the whole quoted value.
const MANIFEST_ELEMENT =
  /<script\b[^>]*?\btype\s*=\s*(["'])application\/specwithcode-app\+json\1[^>]*>([\s\S]*?)<\/script\s*>/i;

/**
 * The powers a page's file declares, in the fixed order of the power list.
 * Unknown names, duplicates and anything malformed declare nothing.
 */
export function readArtifactAppManifest(html: string): ReadonlyArray<ArtifactAppPower> {
  const body = MANIFEST_ELEMENT.exec(html)?.[2];
  if (body === undefined || body.length > MANIFEST_MAX_CHARS) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(body);
  } catch {
    return [];
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return [];
  const permissions = (manifest as { readonly permissions?: unknown }).permissions;
  if (!Array.isArray(permissions) || permissions.length > MANIFEST_MAX_ENTRIES) return [];
  const declared = new Set<string>();
  for (const entry of permissions) {
    if (typeof entry === "string" && POWERS.has(entry)) declared.add(entry);
  }
  return ARTIFACT_APP_POWERS.filter((power) => declared.has(power));
}

/** Each power in plain words, as the consent dialog and the Permissions menu list them. */
export function artifactAppPowerLabel(power: ArtifactAppPower, platform: NodeJS.Platform): string {
  switch (power) {
    case "notifications":
      return "Show notifications";
    case "tray":
      return platform === "darwin"
        ? "Add an item to the menu bar"
        : "Add an item to the system tray";
    case "always-on-top":
      return "Keep its window above other windows";
    case "global-shortcuts":
      return "Respond to keyboard shortcuts while you use other apps";
  }
}

/** The dialog button that allows; every other answer, a closed dialog included, allows nothing. */
export const ARTIFACT_APP_CONSENT_ALLOW = 0;

/** The native consent dialog for one version. Cancel is the default and the answer to Escape. */
export function artifactAppConsentDialog(input: {
  readonly name: string;
  readonly powers: ReadonlyArray<ArtifactAppPower>;
  readonly platform: NodeJS.Platform;
}): Electron.MessageBoxOptions {
  return {
    type: "question",
    message: `Allow ${input.name} to do this on your computer?`,
    detail: [
      ...input.powers.map((power) => `• ${artifactAppPowerLabel(power, input.platform)}`),
      "",
      "This is for this version of the page only. SpecWithCode asks again when the page changes. It still can't reach your files or run programs.",
    ].join("\n"),
    buttons: ["Allow", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

export type ArtifactAppPowerRequest =
  | {
      readonly power: "notifications";
      readonly method: "app/notify";
      readonly title: string;
      readonly body: string;
    }
  | {
      readonly power: "tray";
      readonly method: "app/tray/set";
      readonly title: string | undefined;
      readonly tooltip: string;
      readonly items: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    }
  | {
      readonly power: "always-on-top";
      readonly method: "app/window/always-on-top";
      readonly on: boolean;
    }
  | {
      readonly power: "global-shortcuts";
      readonly method: "app/shortcut/register" | "app/shortcut/unregister";
      readonly accelerator: string;
    };

// Printable text only: no control characters, so a page cannot break a menu or a notification.
function text(value: unknown, max: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string") return undefined;
  // oxlint-disable-next-line no-control-regex -- control characters are what this strips.
  const cleaned = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  if (cleaned.length > max || (!allowEmpty && cleaned.length === 0)) return undefined;
  return cleaned;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A well-formed request and the power it needs, or undefined for anything else. */
export function readArtifactAppPowerRequest(
  method: string,
  rawParams: unknown,
): ArtifactAppPowerRequest | undefined {
  const params = record(rawParams);
  if (params === undefined) return undefined;
  switch (method) {
    case "app/notify": {
      const title = text(params.title, NOTIFICATION_TITLE_MAX);
      const body = text(params.body, NOTIFICATION_BODY_MAX, true);
      if (title === undefined || body === undefined) return undefined;
      return { power: "notifications", method, title, body };
    }
    case "app/tray/set": {
      const title =
        params.title === undefined ? undefined : text(params.title, TRAY_TITLE_MAX, true);
      const tooltip = text(params.tooltip, TRAY_TOOLTIP_MAX);
      if (tooltip === undefined || (params.title !== undefined && title === undefined)) {
        return undefined;
      }
      if (!Array.isArray(params.items) || params.items.length > ARTIFACT_APP_TRAY_ITEM_LIMIT) {
        return undefined;
      }
      const items: Array<{ id: string; label: string }> = [];
      const ids = new Set<string>();
      for (const rawItem of params.items) {
        const item = record(rawItem);
        const id = text(item?.id, TRAY_ITEM_ID_MAX);
        const label = text(item?.label, TRAY_ITEM_LABEL_MAX);
        if (id === undefined || label === undefined || ids.has(id)) return undefined;
        ids.add(id);
        items.push({ id, label });
      }
      return {
        power: "tray",
        method,
        title: title === "" ? undefined : title,
        tooltip,
        items,
      };
    }
    case "app/window/always-on-top":
      return typeof params.on === "boolean"
        ? { power: "always-on-top", method, on: params.on }
        : undefined;
    case "app/shortcut/register":
    case "app/shortcut/unregister":
      return typeof params.accelerator === "string" &&
        params.accelerator.length > 0 &&
        params.accelerator.length <= ACCELERATOR_MAX
        ? { power: "global-shortcuts", method, accelerator: params.accelerator }
        : undefined;
    default:
      return undefined;
  }
}

type Modifier = "Command" | "Control" | "Alt" | "Shift" | "Super";
const MODIFIER_ORDER: ReadonlyArray<Modifier> = ["Command", "Control", "Alt", "Shift", "Super"];

function modifierOf(token: string, platform: NodeJS.Platform): Modifier | undefined {
  switch (token.toLowerCase()) {
    case "command":
    case "cmd":
      // Electron only knows Command on macOS.
      return platform === "darwin" ? "Command" : undefined;
    case "control":
    case "ctrl":
      return "Control";
    case "commandorcontrol":
    case "cmdorctrl":
      return platform === "darwin" ? "Command" : "Control";
    case "alt":
    case "option":
      return "Alt";
    case "shift":
      return "Shift";
    case "super":
    case "meta":
      // The Command key on macOS; the Windows key elsewhere.
      return platform === "darwin" ? "Command" : "Super";
    default:
      return undefined;
  }
}

const NAMED_KEYS: ReadonlyMap<string, string> = new Map(
  [
    "Space",
    "Tab",
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "Delete",
    "Backspace",
    "Escape",
    "Enter",
  ].map((key) => [key.toLowerCase(), key]),
);
const KEY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["esc", "Escape"],
  ["return", "Enter"],
]);

function keyOf(token: string): string | undefined {
  if (/^[a-z0-9]$/i.test(token)) return token.toUpperCase();
  const functionKey = /^f([1-9]|1\d|2[0-4])$/i.exec(token);
  if (functionKey) return `F${functionKey[1]}`;
  const lower = token.toLowerCase();
  return NAMED_KEYS.get(lower) ?? KEY_ALIASES.get(lower);
}

/**
 * The accelerator in one canonical spelling for this platform, or null when a
 * page may not take it. A page's shortcut needs two modifiers, at least one of
 * them not Shift, and one key: with fewer it would capture ordinary typing or
 * the editing shortcuts every app uses.
 */
export function normalizeArtifactAppAccelerator(
  accelerator: string,
  platform: NodeJS.Platform,
): string | null {
  if (accelerator.length === 0 || accelerator.length > ACCELERATOR_MAX) return null;
  const tokens = accelerator.split("+");
  const keyToken = tokens.pop();
  if (keyToken === undefined) return null;
  const key = keyOf(keyToken);
  if (key === undefined) return null;
  const modifiers = new Set<Modifier>();
  for (const token of tokens) {
    const modifier = modifierOf(token, platform);
    if (modifier === undefined || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }
  const strong = [...modifiers].filter((modifier) => modifier !== "Shift").length;
  if (modifiers.size < 2 || strong === 0) return null;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

// Combinations the operating system or every app relies on, in canonical spelling.
const RESERVED_ACCELERATORS: ReadonlySet<string> = new Set([
  "Command+Shift+3",
  "Command+Shift+4",
  "Command+Shift+5",
  "Command+Shift+Z",
  "Command+Shift+Q",
  "Command+Shift+Tab",
  "Command+Alt+Escape",
  "Command+Alt+D",
  "Command+Control+Q",
  "Command+Control+F",
  "Command+Control+Space",
  "Control+Shift+Z",
  "Control+Shift+Escape",
  "Control+Shift+Tab",
  "Control+Alt+Delete",
  "Control+Alt+Tab",
  "Alt+Shift+Tab",
  "Shift+Super+S",
]);

/**
 * Whether a canonical accelerator is free for a page: not one the system
 * keeps, and not one of the app's own. `appAccelerators` are the app's menu
 * and shortcut accelerators in Electron's spelling.
 */
export function isArtifactAppAcceleratorFree(input: {
  readonly canonical: string;
  readonly platform: NodeJS.Platform;
  readonly appAccelerators: ReadonlyArray<string>;
}): boolean {
  if (RESERVED_ACCELERATORS.has(input.canonical)) return false;
  // An app accelerator a page could not spell (one modifier, say) can never equal a canonical one.
  return !input.appAccelerators.some(
    (accelerator) =>
      normalizeArtifactAppAccelerator(accelerator, input.platform) === input.canonical,
  );
}

/** At most ten notifications in any minute; `sent` holds the times of the earlier ones. */
export function admitArtifactAppNotification(
  sent: ReadonlyArray<number>,
  now: number,
): { readonly admitted: boolean; readonly sent: ReadonlyArray<number> } {
  // A clock that went backwards must not open the window early: such times stay counted.
  const recent = sent.filter((time) => !(now - time >= ARTIFACT_APP_NOTIFICATION_WINDOW_MS));
  if (recent.length >= ARTIFACT_APP_NOTIFICATION_LIMIT) return { admitted: false, sent: recent };
  return { admitted: true, sent: [...recent, now] };
}

const ATTACHMENT_ID =
  /^[a-z0-9_][a-z0-9_-]{0,127}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-html$/;

/**
 * The file name of a published page inside the attachments folder, or null.
 * Only the shape html_render mints is accepted, which has no dot or separator,
 * so the name can never leave the folder.
 */
export function artifactAppPageFileName(attachmentId: string): string | null {
  return ATTACHMENT_ID.test(attachmentId) ? `${attachmentId}.html` : null;
}

/**
 * The address a version's frame may be at, without its fragment: an http(s)
 * URL with no credentials. Null for anything else, and a frame with no
 * address may go nowhere.
 */
export function artifactAppVersionUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "" || url.host === "") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
