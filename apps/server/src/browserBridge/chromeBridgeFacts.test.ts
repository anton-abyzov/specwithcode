import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  chromeProfileNames,
  claudeChromeFacts,
  liveExtensionConnections,
  providerWiring,
  specWithCodeBrowserPaired,
} from "./chromeBridgeFacts.ts";

let home: string;
beforeEach(async () => {
  home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "chrome-facts-"));
});
afterEach(async () => {
  await NodeFSP.rm(home, { recursive: true, force: true });
});
const put = async (path: string, text: string) => {
  const target = NodePath.join(home, path);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await NodeFSP.writeFile(target, text);
};
const paths = () => ({
  home,
  claudeFile: NodePath.join(home, ".claude.json"),
  codexHome: NodePath.join(home, ".codex"),
  tmpDirs: [home],
});

describe("Chrome facts", () => {
  it("reads only the account, the paired browser and the on/off flag from Claude's config", async () => {
    await put(
      ".claude.json",
      JSON.stringify({
        oauthAccount: { emailAddress: "owner@example.com", accountUuid: "secret-ish" },
        chromeExtension: { pairedDeviceId: "id", pairedDeviceName: "SpecWithCode" },
        claudeInChromeDefaultEnabled: true,
      }),
    );
    expect(claudeChromeFacts(paths().claudeFile)).toEqual({
      account: "owner@example.com",
      pairedBrowserName: "SpecWithCode",
      enabledByDefault: true,
      installed: true,
    });
  });
  it("lists Chrome profile names, or null when the folder is unreadable", async () => {
    expect(chromeProfileNames(home)).toBeNull();
    await put(
      "Library/Application Support/Google/Chrome/Local State",
      JSON.stringify({
        profile: {
          info_cache: { Default: { name: "Personal" }, "Profile 2": { name: "SpecWithCode" } },
        },
      }),
    );
    expect(chromeProfileNames(home)).toEqual(["Personal", "SpecWithCode"]);
  });
  it("counts native hosts whose process is alive", async () => {
    const bridge = `claude-mcp-browser-bridge-${NodeOS.userInfo().username}`;
    await put(`${bridge}/${process.pid}.sock`, "");
    await put(`${bridge}/999999.sock`, "");
    expect(liveExtensionConnections([home])).toBe(1);
  });
  it("tells each provider's route to Chrome apart", async () => {
    await put(".claude.json", JSON.stringify({ claudeInChromeDefaultEnabled: true }));
    await put(".codex/config.toml", '[plugins."chrome@openai-bundled"]\nenabled = true\n');
    await put(
      ".gemini/settings.json",
      JSON.stringify({
        mcpServers: { chrome: { command: "claude", args: ["--claude-in-chrome-mcp"] } },
      }),
    );
    await NodeFSP.mkdir(NodePath.join(home, ".copilot"));
    const claude = claudeChromeFacts(paths().claudeFile);
    expect(providerWiring(paths(), claude)).toEqual([
      { provider: "claude", route: "built_in" },
      { provider: "codex", route: "own_extension" },
      { provider: "copilot", route: "not_set_up" },
      { provider: "gemini", route: "shared_bridge" },
    ]);
  });

  it("says Claude threads use SpecWithCode Browser once a profile is paired", async () => {
    await put(".claude.json", JSON.stringify({ claudeInChromeDefaultEnabled: true }));
    const claude = claudeChromeFacts(paths().claudeFile);
    const claudeRoute = (useSpecWithCode: boolean) =>
      providerWiring(paths(), claude, useSpecWithCode).find((w) => w.provider === "claude")?.route;
    expect(claudeRoute(false)).toBe("built_in");
    expect(claudeRoute(true)).toBe("specwithcode_browser");
    expect(specWithCodeBrowserPaired(home)).toBe(false);
    await put("browser-extension/pairing.json", JSON.stringify({ token: "t".repeat(43) }));
    expect(specWithCodeBrowserPaired(home)).toBe(false);
    await put(
      "browser-extension/pairing.json",
      JSON.stringify({ token: "t".repeat(43), connectedAt: "2026-10-23T12:00:00.000Z" }),
    );
    expect(specWithCodeBrowserPaired(home)).toBe(true);
  });
});
