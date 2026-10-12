/**
 * The bridge between a mod's sandboxed frame and the workbench.
 *
 * A mod's frame can post anything, so every message is checked here before
 * the host acts on it: unknown shapes are dropped, text is bounded, and UI
 * trees are rebuilt from a small allowlist of elements and props. The host
 * renders those trees with React, never as HTML.
 */
import type { ModPermission } from "@specweave-studio/contracts";

export const MOD_COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
export const MOD_PANE_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
export const MAX_MOD_COMMANDS = 16;
export const MAX_MOD_PANES = 4;
export const MAX_TREE_NODES = 400;
export const MAX_TREE_DEPTH = 12;
export const MAX_TEXT_LENGTH = 2000;

/** A request a mod makes of the host; each needs a declared permission. */
export const MOD_REQUEST_PERMISSIONS = {
  "threads.list": "threads:read",
  "threads.open": "threads:open",
  "specweave.list": "specweave:read",
} as const satisfies Record<string, ModPermission>;
export type ModRequestMethod = keyof typeof MOD_REQUEST_PERMISSIONS;

export type ModTone = "default" | "muted" | "strong" | "success" | "warning" | "danger";
export type ModButtonVariant = "default" | "outline" | "ghost";

export type ModNode =
  | string
  | {
      readonly type: "Box";
      readonly direction: "row" | "column";
      readonly gap: number;
      readonly children: ReadonlyArray<ModNode>;
    }
  | {
      readonly type: "Text";
      readonly tone: ModTone;
      readonly mono: boolean;
      readonly children: ReadonlyArray<ModNode>;
    }
  | {
      readonly type: "Button";
      readonly variant: ModButtonVariant;
      readonly disabled: boolean;
      readonly handler: number | null;
      readonly children: ReadonlyArray<ModNode>;
    };

export type FrameMessage =
  | { readonly type: "loaded" }
  | { readonly type: "started" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "command.register"; readonly name: string; readonly description: string }
  | { readonly type: "ui.toast"; readonly text: string }
  | { readonly type: "ui.status"; readonly text: string | null }
  | { readonly type: "ui.open"; readonly id: string; readonly title: string }
  | { readonly type: "ui.close"; readonly id: string }
  | { readonly type: "ui.tree"; readonly id: string; readonly tree: ModNode | null }
  | {
      readonly type: "request";
      readonly requestId: number;
      readonly method: ModRequestMethod;
      readonly threadId: string | null;
    };

const TONES: ReadonlySet<string> = new Set([
  "default",
  "muted",
  "strong",
  "success",
  "warning",
  "danger",
]);
const VARIANTS: ReadonlySet<string> = new Set(["default", "outline", "ghost"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Trims and bounds text a mod shows; non-strings become null. */
export function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length === 0) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Rebuilds a mod's UI tree from the allowlist, or null if it is unusable. */
export function parseModTree(value: unknown): ModNode | null {
  let nodes = 0;
  let textLength = 0;
  const visit = (raw: unknown, depth: number): ModNode | null => {
    if (++nodes > MAX_TREE_NODES || depth > MAX_TREE_DEPTH) return null;
    if (typeof raw === "string" || typeof raw === "number") {
      const text = String(raw);
      textLength += text.length;
      return textLength > MAX_TEXT_LENGTH * 4 ? null : text.slice(0, MAX_TEXT_LENGTH);
    }
    if (!isRecord(raw)) return null;
    const props = isRecord(raw.props) ? raw.props : {};
    const rawChildren = Array.isArray(raw.children) ? raw.children : [];
    const children: ModNode[] = [];
    for (const child of rawChildren) {
      const parsed = visit(child, depth + 1);
      if (parsed === null) return null;
      children.push(parsed);
    }
    switch (raw.type) {
      case "Box":
        return {
          type: "Box",
          direction: props.direction === "row" ? "row" : "column",
          gap:
            typeof props.gap === "number" && Number.isFinite(props.gap)
              ? Math.min(6, Math.max(0, Math.round(props.gap)))
              : 1,
          children,
        };
      case "Text":
        return {
          type: "Text",
          tone:
            typeof props.tone === "string" && TONES.has(props.tone)
              ? (props.tone as ModTone)
              : "default",
          mono: props.mono === true,
          children,
        };
      case "Button":
        return {
          type: "Button",
          variant:
            typeof props.variant === "string" && VARIANTS.has(props.variant)
              ? (props.variant as ModButtonVariant)
              : "outline",
          disabled: props.disabled === true,
          handler:
            typeof props.onPress === "number" && Number.isSafeInteger(props.onPress)
              ? props.onPress
              : null,
          children,
        };
      default:
        return null;
    }
  };
  return visit(value, 0);
}

/** Checks one message from a mod's frame; anything unexpected is null. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!isRecord(data) || typeof data.type !== "string") return null;
  switch (data.type) {
    case "loaded":
    case "started":
      return { type: data.type };
    case "error":
      return { type: "error", message: boundedText(data.message, 300) ?? "The mod failed." };
    case "command.register": {
      if (typeof data.name !== "string" || !MOD_COMMAND_PATTERN.test(data.name)) return null;
      return {
        type: "command.register",
        name: data.name,
        description: boundedText(data.description, 120) ?? data.name,
      };
    }
    case "ui.toast": {
      const text = boundedText(data.text, 200);
      return text === null ? null : { type: "ui.toast", text };
    }
    case "ui.status":
      return { type: "ui.status", text: boundedText(data.text, 40) };
    case "ui.open": {
      if (typeof data.id !== "string" || !MOD_PANE_PATTERN.test(data.id)) return null;
      return { type: "ui.open", id: data.id, title: boundedText(data.title, 80) ?? data.id };
    }
    case "ui.close":
      return typeof data.id === "string" && MOD_PANE_PATTERN.test(data.id)
        ? { type: "ui.close", id: data.id }
        : null;
    case "ui.tree": {
      if (typeof data.id !== "string" || !MOD_PANE_PATTERN.test(data.id)) return null;
      return {
        type: "ui.tree",
        id: data.id,
        tree: data.tree === null || data.tree === undefined ? null : parseModTree(data.tree),
      };
    }
    case "request": {
      if (typeof data.requestId !== "number" || !Number.isSafeInteger(data.requestId)) return null;
      if (
        data.method !== "threads.list" &&
        data.method !== "threads.open" &&
        data.method !== "specweave.list"
      )
        return null;
      const threadId =
        typeof data.threadId === "string" && data.threadId.length > 0 && data.threadId.length <= 200
          ? data.threadId
          : null;
      if (data.method === "threads.open" && threadId === null) return null;
      return { type: "request", requestId: data.requestId, method: data.method, threadId };
    }
    default:
      return null;
  }
}

/** A mod may only open threads shortly after the user acted on it. */
export const USER_ACTION_WINDOW_MS = 5_000;

export interface ModRequestDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function decideModRequest(input: {
  readonly method: ModRequestMethod;
  readonly permissions: ReadonlyArray<ModPermission>;
  readonly lastUserActionAt: number | null;
  readonly now: number;
}): ModRequestDecision {
  const permission = MOD_REQUEST_PERMISSIONS[input.method];
  if (!input.permissions.includes(permission)) {
    return { allowed: false, reason: `This mod was not approved for ${permission}.` };
  }
  if (
    input.method === "threads.open" &&
    (input.lastUserActionAt === null || input.now - input.lastUserActionAt > USER_ACTION_WINDOW_MS)
  ) {
    return { allowed: false, reason: "A mod can open a thread only right after you use it." };
  }
  return { allowed: true };
}

/** Keeps a chatty mod from flooding the workbench with toasts. */
export class ToastBudget {
  private readonly sent: number[] = [];
  constructor(
    private readonly limit = 3,
    private readonly windowMs = 10_000,
  ) {}
  take(now: number): boolean {
    while (this.sent.length > 0 && now - this.sent[0]! > this.windowMs) this.sent.shift();
    if (this.sent.length >= this.limit) return false;
    this.sent.push(now);
    return true;
  }
}
