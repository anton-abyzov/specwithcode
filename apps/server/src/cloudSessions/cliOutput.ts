import {
  CLOUD_SESSIONS_MIN_CLI_VERSION,
  type CloudSessionAvailability,
  type CloudSessionAvailabilityStatus,
} from "@specweave-studio/contracts";

/**
 * Pure readers for what the Claude Code CLI prints around cloud sessions.
 * The interactive `claude --cloud` run draws with cursor movement, so text is
 * reconstructed from the escape sequences before anything is matched; the
 * matchers tolerate lost spaces, because a cursor-forward sequence is the
 * only thing that separates many words on screen.
 */

/** Turns a pseudo-terminal capture into plain lines: cursor-forward becomes spaces, everything else is dropped. */
export function stripTerminalOutput(raw: string): string {
  // Escape sequences are the whole point of this reader.
  /* eslint-disable no-control-regex */
  return raw
    .replace(/\u001b\[(\d*)C/g, (_match, count: string) => " ".repeat(Number(count) || 1))
    .replace(/\u001b\[[0-9;?<>=]*[A-Za-z]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b[()][A-Za-z0-9]/g, "")
    .replace(/\u001b[=>]/g, "")
    .replace(/\r/g, "\n");
  /* eslint-enable no-control-regex */
}

const TRUST_PROMPT = /trust\s*this\s*folder|is\s*this\s*a\s*project\s*you\s*created/i;

/** A question the interactive CLI is waiting on before it creates the session. */
export type CloudCliPrompt = "trust_folder";

export function detectCloudCliPrompt(plain: string): CloudCliPrompt | null {
  return TRUST_PROMPT.test(plain) ? "trust_folder" : null;
}

export interface CloudSessionCreated {
  readonly sessionId: string;
  readonly url: string;
  readonly title: string | null;
}

const SESSION_URL = /https:\/\/claude\.ai\/code\/((?:session|cse)_[A-Za-z0-9]+)[^\s"'<>]*/;
const TELEPORT_LINE = /claude\s*--teleport\s*((?:session|cse)_[A-Za-z0-9]+)/;
const SESSION_ID_LINE = /Session\s*ID:\s*((?:session|cse)_[A-Za-z0-9]+)/;
const CREATED_LINE = /Created\s*cloud\s*session:\s*(.+)/;

/** The session the CLI reports once provisioning finished, or null while it is still working. */
export function parseCloudSessionCreated(plain: string): CloudSessionCreated | null {
  const url = plain.match(SESSION_URL);
  const id =
    url?.[1] ?? plain.match(TELEPORT_LINE)?.[1] ?? plain.match(SESSION_ID_LINE)?.[1] ?? null;
  if (id === null) return null;
  const title = plain.match(CREATED_LINE)?.[1]?.trim() ?? null;
  return {
    sessionId: id,
    url: url?.[0] ?? `https://claude.ai/code/${id}`,
    title: title === null || title.length === 0 ? null : title,
  };
}

const CREATE_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /Unable\s*to\s*get\s*organization\s*UUID|need\s*a\s*claude\.ai\s*sign-?in|Please\s*run\s*\/login/i,
    "Claude Code is not signed in with a claude.ai account. Run `claude auth login` on this machine.",
  ],
  [
    /disabled\s*by\s*your\s*organization/i,
    "Cloud sessions are disabled by the organization's policy. An Owner enables them at claude.ai/admin-settings/claude-code.",
  ],
  [
    /aren't\s*available\s*with|not\s*available\s*with\s*(Amazon|Google|Microsoft)/i,
    "Cloud sessions need an Anthropic account; Claude Code is configured for a third-party provider here.",
  ],
  [
    /Not\s*uploading\s*this\s*working\s*tree/i,
    "Claude Code refused to upload this checkout; the message above names the cause.",
  ],
  [
    /Session\s*creation\s*failed/i,
    "Claude Code could not allocate a cloud VM. Check status.claude.com and retry in a minute.",
  ],
  [/Workspace\s*not\s*trusted/i, "Claude Code does not trust this folder yet."],
];

/** A known failure the CLI printed, in words the user can act on, or null. */
export function detectCloudCreateFailure(plain: string): string | null {
  for (const [pattern, message] of CREATE_FAILURES) if (pattern.test(plain)) return message;
  return null;
}

export interface CloudSendOutput {
  readonly ok: boolean;
  readonly sessionId: string | null;
  readonly url: string | null;
  readonly error: string | null;
}

/** `claude -p … --cloud <id> --output-format json` prints `{ok, session_id, url}` or `{ok: false, session_id, error}`. */
export function parseCloudSendOutput(
  stdout: string,
  stderr: string,
  code: number,
): CloudSendOutput {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .toReversed()
    .find((entry) => entry.startsWith("{") && entry.endsWith("}"));
  if (line !== undefined) {
    try {
      const parsed = JSON.parse(line) as {
        ok?: unknown;
        session_id?: unknown;
        url?: unknown;
        error?: unknown;
      };
      return {
        ok: parsed.ok === true,
        sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
        url: typeof parsed.url === "string" ? parsed.url : null,
        error:
          parsed.ok === true
            ? null
            : typeof parsed.error === "string"
              ? parsed.error
              : "The CLI reported a failure without a message.",
      };
    } catch {
      // Fall through to the plain-text reading.
    }
  }
  const plain = `${stdout}\n${stderr}`.trim();
  const url = plain.match(SESSION_URL);
  if (code === 0 && url) return { ok: true, sessionId: url[1]!, url: url[0], error: null };
  const errorLine = plain
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && /error|cannot|not\s|failed|archived/i.test(entry));
  return {
    ok: false,
    sessionId: null,
    url: null,
    error:
      errorLine ?? (plain.length > 0 ? plain.slice(0, 500) : `The CLI exited with code ${code}.`),
  };
}

export interface ClaudeAuthStatus {
  readonly loggedIn: boolean;
  readonly authMethod: string | null;
  readonly subscriptionType: string | null;
}

/** `claude auth status` JSON, reading only the fields cloud sessions depend on. */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as {
      loggedIn?: unknown;
      authMethod?: unknown;
      subscriptionType?: unknown;
    };
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType:
        typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

export function parseClaudeVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

/** Negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export interface AvailabilityInput {
  readonly cliFound: boolean;
  readonly cliVersion: string | null;
  readonly auth: ClaudeAuthStatus | null;
  readonly checkedAt: string;
}

const describe = (
  status: CloudSessionAvailabilityStatus,
  reason: string,
  fix: string | null,
  input: AvailabilityInput,
): CloudSessionAvailability => ({
  status,
  cliVersion: input.cliVersion,
  authMethod: input.auth?.authMethod ?? null,
  subscriptionType: input.auth?.subscriptionType ?? null,
  reason,
  fix,
  checkedAt: input.checkedAt as CloudSessionAvailability["checkedAt"],
});

/** What the CLI's version and sign-in say about starting cloud sessions here. */
export function availabilityFrom(input: AvailabilityInput): CloudSessionAvailability {
  if (!input.cliFound)
    return describe(
      "cli_missing",
      "Claude Code is not installed on this machine.",
      "Install Claude Code, then sign in with `claude auth login`.",
      input,
    );
  if (
    input.cliVersion !== null &&
    compareVersions(input.cliVersion, CLOUD_SESSIONS_MIN_CLI_VERSION) < 0
  )
    return describe(
      "cli_too_old",
      `Claude Code ${input.cliVersion} predates cloud sessions from the CLI (needs ${CLOUD_SESSIONS_MIN_CLI_VERSION} or later).`,
      "Run `claude update`.",
      input,
    );
  if (input.auth === null)
    return describe(
      "unknown",
      "Claude Code did not report its sign-in state.",
      "Run `claude auth status` on this machine to see why.",
      input,
    );
  if (!input.auth.loggedIn || input.auth.authMethod === null || input.auth.authMethod === "none")
    return describe(
      "needs_login",
      "Claude Code is not signed in.",
      "Run `claude auth login` with a Pro, Max or Team account.",
      input,
    );
  if (input.auth.authMethod !== "claude.ai")
    return describe(
      "unsupported_auth",
      `Claude Code is signed in with ${describeAuthMethod(input.auth.authMethod)}; cloud sessions need a claude.ai sign-in.`,
      "Run `claude auth login` with a Pro, Max or Team account, and unset ANTHROPIC_API_KEY for the app's service if it is set.",
      input,
    );
  const plan = input.auth.subscriptionType;
  return describe(
    "ready",
    plan === null
      ? "Signed in with claude.ai; cloud sessions draw from this account's plan usage."
      : `Signed in with a claude.ai ${plan} plan; cloud sessions draw from its usage limits.`,
    null,
    input,
  );
}

function describeAuthMethod(method: string): string {
  switch (method) {
    case "api_key":
    case "api_key_helper":
      return "an API key";
    case "oauth_token":
      return "a long-lived token from `claude setup-token`";
    case "third_party":
      return "a third-party provider (Bedrock, Vertex or Foundry)";
    default:
      return method;
  }
}
