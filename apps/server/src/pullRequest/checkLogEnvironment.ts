/**
 * The environment `gh run view` reads a failed check's log with. A token from the app's own
 * credential goes to the variable gh reads for that host. Enterprise tokens inherited from the
 * app's environment are always cleared: gh sends them to whichever enterprise host it is pointed
 * at, and a token meant for one host must not reach another checkout's host.
 */
export function checkLogEnvironment(host: string, token: string | null): Record<string, string> {
  const gitHubDotCom = host === "github.com" || host.endsWith(".ghe.com");
  return {
    GH_DEBUG: "",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    GH_HOST: host,
    GH_ENTERPRISE_TOKEN: "",
    GITHUB_ENTERPRISE_TOKEN: "",
    ...(token === null ? {} : gitHubDotCom ? { GH_TOKEN: token } : { GH_ENTERPRISE_TOKEN: token }),
  };
}
