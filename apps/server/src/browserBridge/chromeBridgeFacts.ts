/**
 * What this machine can say about Chrome without asking Chrome: is it
 * installed and running, can it launch Claude Code's native host, how many
 * extension pages are talking to it, and how each provider is wired to it.
 * Reads only names and flags; never cookies, passwords or tokens.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - a bounded synchronous facts reader shared with tests.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - same reader; every read is size-capped.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - paths for the same reader.
import * as NodePath from "node:path";
import type { BrowserBridgeProviderWiring } from "@specweave-studio/contracts";
import { parse } from "smol-toml";
import { BROWSER_MCP_FLAG } from "./chromeBridgeProbe.ts";

type ObjectValue = Record<string, unknown>;
const isObject = (v: unknown): v is ObjectValue =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

export interface ChromeBridgePaths {
  readonly home: string;
  /** Claude Code's `.claude.json` for the configured Claude instance. */
  readonly claudeFile: string;
  readonly codexHome: string;
  readonly tmpDirs: ReadonlyArray<string>;
}

export const defaultChromeBridgePaths = (claudeConfigDir: string | null): ChromeBridgePaths => {
  const home = NodeOS.homedir();
  return {
    home,
    claudeFile: claudeConfigDir
      ? NodePath.join(claudeConfigDir, ".claude.json")
      : NodePath.join(home, ".claude.json"),
    codexHome: process.env.CODEX_HOME?.trim() || NodePath.join(home, ".codex"),
    tmpDirs: [...new Set(["/tmp", NodeOS.tmpdir()])],
  };
};

const chromeSupport = (home: string) =>
  NodePath.join(home, "Library", "Application Support", "Google", "Chrome");

function readJson(path: string): ObjectValue | null {
  try {
    if (NodeFS.statSync(path).size > MAX_CONFIG_BYTES) return null;
    const data: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    return isObject(data) ? data : null;
  } catch {
    return null;
  }
}

function readToml(path: string): ObjectValue | null {
  try {
    if (NodeFS.statSync(path).size > MAX_CONFIG_BYTES) return null;
    const data: unknown = parse(NodeFS.readFileSync(path, "utf8"));
    return isObject(data) ? data : null;
  } catch {
    return null;
  }
}

export function chromeInstalled(home: string): boolean {
  return ["/Applications", NodePath.join(home, "Applications")].some((dir) =>
    NodeFS.existsSync(NodePath.join(dir, "Google Chrome.app")),
  );
}

export function chromeRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "ps",
      ["-Ao", "comm="],
      { timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
      (error, out) =>
        resolve(!error && /Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/m.test(String(out))),
    );
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Native hosts Chrome started for the extension; each listens on `<pid>.sock` while its page is open. */
export function liveExtensionConnections(tmpDirs: ReadonlyArray<string>): number {
  const user = NodeOS.userInfo().username;
  const pids = new Set<number>();
  for (const dir of tmpDirs) {
    const bridge = NodePath.join(dir, `claude-mcp-browser-bridge-${user}`);
    let names: string[] = [];
    try {
      names = NodeFS.readdirSync(bridge);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^(\d+)\.sock$/.exec(name);
      if (match && alive(Number(match[1]))) pids.add(Number(match[1]));
    }
  }
  return pids.size;
}

export function nativeHostInstalled(home: string): boolean {
  return NodeFS.existsSync(
    NodePath.join(
      chromeSupport(home),
      "NativeMessagingHosts",
      "com.anthropic.claude_code_browser_extension.json",
    ),
  );
}

/** Profile names from Chrome's Local State, or null when macOS keeps the folder private. */
export function chromeProfileNames(home: string): string[] | null {
  const state = readJson(NodePath.join(chromeSupport(home), "Local State"));
  const cache = isObject(state?.profile) ? state.profile.info_cache : undefined;
  if (!isObject(cache)) return null;
  return Object.values(cache)
    .map((entry) => (isObject(entry) && typeof entry.name === "string" ? entry.name : null))
    .filter((name): name is string => name !== null)
    .sort((a, b) => a.localeCompare(b));
}

export interface ClaudeChromeFacts {
  readonly account: string | null;
  readonly pairedBrowserName: string | null;
  readonly enabledByDefault: boolean;
  readonly installed: boolean;
}

/** Only the account email, the paired browser's name and the on/off flag are read. */
export function claudeChromeFacts(claudeFile: string): ClaudeChromeFacts {
  const config = readJson(claudeFile);
  const account = isObject(config?.oauthAccount) ? config.oauthAccount.emailAddress : undefined;
  const paired = isObject(config?.chromeExtension)
    ? config.chromeExtension.pairedDeviceName
    : undefined;
  return {
    account: typeof account === "string" ? account : null,
    pairedBrowserName: typeof paired === "string" ? paired : null,
    enabledByDefault: config?.claudeInChromeDefaultEnabled !== false,
    installed: config !== null,
  };
}

/** True when an MCP declaration runs Claude Code's browser server. */
const runsBrowserMcp = (servers: unknown) =>
  isObject(servers) &&
  Object.values(servers).some(
    (server) =>
      isObject(server) &&
      server.enabled !== false &&
      Array.isArray(server.args) &&
      server.args.includes(BROWSER_MCP_FLAG),
  );

export function providerWiring(
  paths: ChromeBridgePaths,
  claude: ClaudeChromeFacts,
): BrowserBridgeProviderWiring[] {
  const codexConfig = readToml(NodePath.join(paths.codexHome, "config.toml"));
  const codexPlugins = isObject(codexConfig?.plugins) ? codexConfig.plugins : {};
  const codexChrome = Object.entries(codexPlugins).some(
    ([key, value]) => key.split("@")[0] === "chrome" && isObject(value) && value.enabled === true,
  );
  const copilotDir = NodePath.join(paths.home, ".copilot");
  const geminiDir = NodePath.join(paths.home, ".gemini");
  const sharedOr = (installed: boolean, servers: unknown): BrowserBridgeProviderWiring["route"] =>
    !installed ? "not_installed" : runsBrowserMcp(servers) ? "shared_bridge" : "not_set_up";
  return [
    {
      provider: "claude",
      route: !claude.installed
        ? "not_installed"
        : claude.enabledByDefault
          ? "built_in"
          : "turned_off",
    },
    {
      provider: "codex",
      route:
        codexConfig === null
          ? NodeFS.existsSync(paths.codexHome)
            ? "not_set_up"
            : "not_installed"
          : runsBrowserMcp(codexConfig.mcp_servers)
            ? "shared_bridge"
            : codexChrome
              ? "own_extension"
              : "not_set_up",
    },
    {
      provider: "copilot",
      route: sharedOr(
        NodeFS.existsSync(copilotDir),
        readJson(NodePath.join(copilotDir, "mcp-config.json"))?.mcpServers,
      ),
    },
    {
      provider: "gemini",
      route: sharedOr(
        NodeFS.existsSync(geminiDir),
        readJson(NodePath.join(geminiDir, "settings.json"))?.mcpServers,
      ),
    },
  ];
}
