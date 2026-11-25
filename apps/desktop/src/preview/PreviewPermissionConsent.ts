/**
 * Permissions a preview page gets only after the person allows them for its
 * origin. Each answer lasts for the preview session, like Chrome's own
 * prompts. Electron-free so the decision logic is unit-testable.
 */
export const CONSENT_PREVIEW_PERMISSIONS = [
  "clipboard-read",
  "notifications",
  "geolocation",
] as const;
export type ConsentPreviewPermission = (typeof CONSENT_PREVIEW_PERMISSIONS)[number];

export const isConsentPreviewPermission = (
  permission: string,
): permission is ConsentPreviewPermission =>
  (CONSENT_PREVIEW_PERMISSIONS as ReadonlyArray<string>).includes(permission);

/**
 * The origin a decision is remembered under, or null when the frame's origin
 * cannot be read. `about:srcdoc`, `about:blank` and `data:` frames inherit or
 * hide their origin, so they are refused rather than guessed.
 */
export function permissionOrigin(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

const PROMPT_ORIGIN_MAX_CHARS = 80;
const truncateForPrompt = (origin: string): string =>
  origin.length > PROMPT_ORIGIN_MAX_CHARS
    ? `${origin.slice(0, PROMPT_ORIGIN_MAX_CHARS - 1)}…`
    : origin;

export function consentPromptMessage(permission: ConsentPreviewPermission, origin: string): string {
  const site = truncateForPrompt(origin);
  switch (permission) {
    case "clipboard-read":
      return `${site} wants to see text and images copied to the clipboard`;
    case "notifications":
      return `${site} wants to show notifications`;
    case "geolocation":
      return `${site} wants to know your location`;
  }
}

/** Resolves true for Allow, false for Block, undefined when no answer was given. */
export type AskPermission = (
  requester: unknown,
  permission: ConsentPreviewPermission,
  origin: string,
) => Promise<boolean | undefined>;

export function makePreviewPermissionConsent(ask: AskPermission) {
  const decisions = new Map<ConsentPreviewPermission, Map<string, boolean>>(
    CONSENT_PREVIEW_PERMISSIONS.map((permission) => [permission, new Map()]),
  );
  // Agents browse unattended, so repeated requests share one open prompt.
  const pending = new Map<string, Promise<boolean>>();

  const request = (
    requester: unknown,
    permission: ConsentPreviewPermission,
    requestingUrl: string | undefined,
    callback: (granted: boolean) => void,
  ): void => {
    const origin = permissionOrigin(requestingUrl);
    if (origin === null) {
      callback(false);
      return;
    }
    const remembered = decisions.get(permission)?.get(origin);
    if (remembered !== undefined) {
      callback(remembered);
      return;
    }
    const key = `${permission}\n${origin}`;
    let answer = pending.get(key);
    if (answer === undefined) {
      answer = ask(requester, permission, origin)
        .catch(() => undefined)
        .then((granted) => {
          pending.delete(key);
          if (granted !== undefined) decisions.get(permission)?.set(origin, granted);
          return granted === true;
        });
      pending.set(key, answer);
    }
    void answer.then(callback);
  };

  /** Synchronous, so it answers only from a decision already made. */
  const check = (permission: ConsentPreviewPermission, requestingOrigin: string): boolean => {
    const origin = permissionOrigin(requestingOrigin);
    return origin !== null && decisions.get(permission)?.get(origin) === true;
  };

  return { request, check };
}
