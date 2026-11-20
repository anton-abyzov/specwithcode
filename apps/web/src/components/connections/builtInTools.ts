/**
 * The tools SpecWithCode ships for agents. They are part of the app and are
 * never added as MCP servers; the MCP tab lists them so nobody goes looking
 * for a server that does the same thing.
 */
export const BUILT_IN_TOOLS = [
  {
    id: "chrome",
    name: "Chrome",
    line: "Agents use your signed-in Chrome, through the extension.",
    link: "Chrome settings",
    to: "/settings/chrome",
    hash: "",
  },
  {
    id: "computer-use",
    name: "Computer use",
    line: "Agents see the screen, click and type in Mac apps. Mac only.",
    link: "Agent access",
    to: "/settings/integrations/access",
    hash: "agent-computer-access",
  },
  {
    id: "in-app-browser",
    name: "In-app browser",
    line: "A browser inside the app for testing sites and screenshots.",
    link: "Agent access",
    to: "/settings/integrations/access",
    hash: "agent-browser-access",
  },
  {
    id: "simulators",
    name: "Simulators",
    line: "iOS Simulator and Android Emulator. They need Xcode or Android Studio.",
    link: "Devices",
    to: "/settings/integrations/devices",
    hash: "devices",
  },
] as const;

export type BuiltInTool = (typeof BUILT_IN_TOOLS)[number];
export type BuiltInToolId = BuiltInTool["id"];
export type BuiltInToolStatus = "on" | "off" | "paired" | "needs-setup" | "mac-only";

export const BUILT_IN_STATUS_LABEL: Record<BuiltInToolStatus, string> = {
  on: "On",
  off: "Off",
  paired: "Paired",
  "needs-setup": "Needs setup",
  "mac-only": "Mac only",
};

/** What the selected machine reports. A fact not yet known is `undefined` or `null`. */
export interface BuiltInToolFacts {
  /** The machine's operating system, `darwin` for a Mac. */
  readonly os: string | undefined;
  readonly computerAccess: boolean | undefined;
  readonly browserAccess: boolean | undefined;
  readonly deviceSupport: boolean | undefined;
  /** Whether a Chrome profile is chosen for agents; null until the machine answers. */
  readonly chromePaired: boolean | null;
  /** Whether a simulator or emulator is ready on the machine; null until it answers. */
  readonly simulatorReady: boolean | null;
}

/** The live status of one built-in tool, or null while the machine has not said. */
export function builtInToolStatus(
  id: BuiltInToolId,
  facts: BuiltInToolFacts,
): BuiltInToolStatus | null {
  switch (id) {
    case "chrome":
      return facts.chromePaired === null ? null : facts.chromePaired ? "paired" : "needs-setup";
    case "computer-use":
      if (facts.os === undefined) return null;
      if (facts.os !== "darwin") return "mac-only";
      return facts.computerAccess === undefined ? null : facts.computerAccess ? "on" : "off";
    case "in-app-browser":
      return facts.browserAccess === undefined ? null : facts.browserAccess ? "on" : "off";
    case "simulators":
      if (facts.deviceSupport === undefined) return null;
      if (!facts.deviceSupport) return "off";
      return facts.simulatorReady === null ? null : facts.simulatorReady ? "on" : "needs-setup";
  }
}
