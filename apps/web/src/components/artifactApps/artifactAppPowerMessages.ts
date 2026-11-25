import type {
  DesktopArtifactAppPermissions,
  DesktopArtifactAppPermissionsInput,
  DesktopArtifactAppPowerEvent,
  DesktopArtifactAppPowerInput,
  DesktopArtifactAppPowerReply,
} from "@specweave-studio/contracts";

/**
 * The messages between an installed page and its window. The page asks for a
 * desktop power on the frame's JSON-RPC channel (`window.parent.postMessage`);
 * the window forwards the request to the shell, which decides it, and posts
 * the reply back. The window never grants anything: its one job is to forward
 * only what its own frame sent, tagged with the version it mounted.
 */

const POWER_METHOD = /^app\/[a-z][a-z/-]{0,56}$/;

export interface ArtifactAppPowerMessage {
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

/** A JSON-RPC request in the `app/` namespace, or undefined for anything else. */
export function readArtifactAppPowerMessage(data: unknown): ArtifactAppPowerMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || typeof method !== "string" || !POWER_METHOD.test(method)) {
    return undefined;
  }
  if (typeof id !== "string" && !Number.isSafeInteger(id)) return undefined;
  if (typeof id === "string" && (id.length === 0 || id.length > 128)) return undefined;
  return { id: id as string | number, method, params };
}

/**
 * Whether a message came from this window's own page frame. The source must be
 * that frame's window, and a sandboxed page without allow-same-origin always
 * posts from the opaque origin. With no frame there is nothing to trust.
 */
export function isOwnFrameMessage(
  event: { readonly source: unknown; readonly origin: string },
  frameWindow: unknown,
): boolean {
  return (
    frameWindow !== null &&
    frameWindow !== undefined &&
    event.source === frameWindow &&
    event.origin === "null"
  );
}

export function artifactAppPowerResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}

export type ArtifactAppPowerErrorCode = Extract<
  DesktopArtifactAppPowerReply,
  { ok: false }
>["error"];

export function artifactAppPowerError(id: string | number, error: ArtifactAppPowerErrorCode) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message: error } } as const;
}

/**
 * Handles one message event in an installed page's window. Returns false, and
 * does nothing at all, unless the message is a power request from the window's
 * own frame. Otherwise the request goes to the shell with the version the
 * window mounted, and the page gets a result or an error: a shell that is
 * missing, fails or answers something unexpected is an error.
 */
export function forwardArtifactAppPowerMessage(input: {
  readonly event: { readonly data: unknown; readonly source: unknown; readonly origin: string };
  /** The page frame's `contentWindow`. */
  readonly frameWindow: unknown;
  /** The version this window mounted in that frame. */
  readonly attachmentId: string;
  readonly power:
    | ((request: DesktopArtifactAppPowerInput) => Promise<DesktopArtifactAppPowerReply>)
    | undefined;
  readonly reply: (message: object) => void;
}): boolean {
  if (!isOwnFrameMessage(input.event, input.frameWindow)) return false;
  const message = readArtifactAppPowerMessage(input.event.data);
  if (message === undefined) return false;
  const refuse = () => input.reply(artifactAppPowerError(message.id, "not-allowed"));
  if (typeof input.power !== "function") {
    refuse();
    return true;
  }
  let pending: Promise<DesktopArtifactAppPowerReply>;
  try {
    pending = input.power({
      attachmentId: input.attachmentId,
      method: message.method,
      params: message.params,
    });
  } catch {
    refuse();
    return true;
  }
  void Promise.resolve(pending).then((reply) => {
    if (reply?.ok === true) return input.reply(artifactAppPowerResult(message.id));
    if (reply?.ok === false && typeof reply.error === "string") {
      return input.reply(artifactAppPowerError(message.id, reply.error));
    }
    refuse();
  }, refuse);
  return true;
}

/**
 * What the page is told when the shell reports a tray click or a shortcut
 * press: a JSON-RPC notification, or undefined when the event is for another
 * version than the one this window shows.
 */
export function artifactAppPowerNotification(
  event: DesktopArtifactAppPowerEvent,
  attachmentId: string,
) {
  if (event.attachmentId !== attachmentId) return undefined;
  return { jsonrpc: "2.0", method: event.method, params: event.params } as const;
}

type PermissionsCall = (
  input: DesktopArtifactAppPermissionsInput,
) => Promise<DesktopArtifactAppPermissions>;

/**
 * Sends Permissions actions to the shell one at a time, in the order asked: a
 * "close" for the version leaving the window always lands before the "open"
 * for the next. Resolves to null when the shell has no such method or fails.
 */
export function makeArtifactAppPermissionsCaller(
  call: () => PermissionsCall | undefined,
): (input: DesktopArtifactAppPermissionsInput) => Promise<DesktopArtifactAppPermissions | null> {
  let queue: Promise<unknown> = Promise.resolve();
  return (input) => {
    const run = async () => {
      const method = call();
      if (typeof method !== "function") return null;
      try {
        return await method(input);
      } catch {
        return null;
      }
    };
    const result = queue.then(run, run);
    queue = result;
    return result;
  };
}

/** The window's one caller, shared by the page frame and the Permissions menu. */
export const callArtifactAppPermissions = makeArtifactAppPermissionsCaller(() =>
  typeof window === "undefined" ? undefined : window.desktopBridge?.artifactAppPermissions,
);
