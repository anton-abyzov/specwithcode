/** What a new Claude account becomes: an instance id, its name, and a home of its own. */
export interface ClaudeAccountPlan {
  readonly instanceId: string;
  readonly displayName: string;
  readonly homePath: string;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * `Work` becomes `claudeAgent_work` in `~/.claude-work`. A taken id or home
 * gets a number, so a second account never shares the first one's sign-in.
 */
export function claudeAccountPlan(
  name: string,
  instances: Readonly<Record<string, { readonly config?: unknown }>>,
): ClaudeAccountPlan {
  const slug = slugify(name) || "account";
  const homes = new Set(
    Object.values(instances).flatMap((instance) => {
      const home = (instance.config as { homePath?: unknown } | undefined)?.homePath;
      return typeof home === "string" ? [home.trim()] : [];
    }),
  );
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const instanceId = `claudeAgent_${slug.replaceAll("-", "_")}${suffix.replace("-", "_")}`;
    const homePath = `~/.claude-${slug}${suffix}`;
    if (!(instanceId in instances) && !homes.has(homePath)) {
      return { instanceId, displayName: `Claude - ${name.trim()}`, homePath };
    }
  }
}

/**
 * The same sign-in as typed in a terminal on that machine, for those who want
 * it. The CLI keeps a separate sign-in per CLAUDE_CONFIG_DIR, so this never
 * replaces the default login. `command` skips a shell function or alias named
 * claude that would add flags `auth login` does not take. Windows gets the
 * PowerShell form.
 */
export function claudeLoginCommand(homePath: string, os?: string): string {
  if (os === "windows") {
    const folder = homePath.replace(/^~[\\/]/, "$HOME\\").replaceAll("/", "\\");
    return `$env:CLAUDE_CONFIG_DIR = "${folder}"; claude auth login`;
  }
  return `CLAUDE_CONFIG_DIR=${homePath} command claude auth login`;
}

/**
 * Whether pasted text can be what Claude's page gives: a code in two parts
 * joined by #, or the address of the page that shows it. The machine checks
 * again; this only saves a round trip for half a paste.
 */
export function isClaudeSignInCode(pasted: string): boolean {
  let text = pasted.trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      text = `${url.searchParams.get("code")?.trim() ?? ""}#${url.searchParams.get("state")?.trim() ?? ""}`;
    } catch {
      return false;
    }
  }
  // Two parts of visible characters joined by one #, as the machine checks it.
  return /^[!-"$-~]+#[!-"$-~]+$/.test(text);
}
