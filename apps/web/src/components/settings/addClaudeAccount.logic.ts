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
 * The one-time sign-in for that home, as typed in a terminal on its machine.
 * The CLI keeps a separate Keychain item per CLAUDE_CONFIG_DIR, so this never
 * replaces the default login. `command` skips a shell function or alias named
 * claude that would add flags `auth login` does not take.
 */
export function claudeLoginCommand(homePath: string): string {
  return `CLAUDE_CONFIG_DIR=${homePath} command claude auth login`;
}
