/**
 * What the personal assistant can connect to from its Services tab. Each preset
 * is an official MCP server at a pinned version, so a package update reaches
 * this machine only through a release of this app.
 */
import type { ProjectConnection, ProjectConnectionConfig } from "@specweave-studio/contracts";

export interface ServicePreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly tokenLabel: string;
  readonly tokenHelp: string;
  readonly tokenUrl: string;
  readonly config: ProjectConnectionConfig;
}

export const SERVICE_PRESETS: readonly ServicePreset[] = [
  {
    id: "service-notion",
    name: "Notion",
    summary: "Pages and databases you share with it",
    tokenLabel: "Notion integration secret",
    tokenHelp: "Create an internal integration, copy its secret, then share pages with it.",
    tokenUrl: "https://www.notion.so/profile/integrations",
    config: {
      name: "Notion",
      command: "npx",
      args: ["-y", "--package=@notionhq/notion-mcp-server@2.6.1", "notion-mcp-server"],
      envKeys: ["NOTION_TOKEN"],
    },
  },
  {
    id: "service-todoist",
    name: "Todoist",
    summary: "Your tasks and projects",
    tokenLabel: "Todoist API token",
    tokenHelp: "Copy the API token from Todoist's developer settings.",
    tokenUrl: "https://app.todoist.com/app/settings/integrations/developer",
    config: {
      name: "Todoist",
      command: "npx",
      args: ["-y", "--package=@doist/todoist-ai@9.0.0", "todoist-ai"],
      envKeys: ["TODOIST_API_KEY"],
    },
  },
];

export type ServiceRowState = "not-connected" | "needs-check" | "ready";

export function serviceRowState(connection: ProjectConnection | undefined): ServiceRowState {
  if (!connection || connection.status === "revoked") return "not-connected";
  return connection.status === "ready" ? "ready" : "needs-check";
}

/** The saved connection's status, in words; a check never proves the account signed in. */
export function serviceStatusText(connection: ProjectConnection | undefined): string {
  switch (serviceRowState(connection)) {
    case "not-connected":
      return "Not connected";
    case "needs-check":
      return "Not working yet";
    case "ready": {
      const allowed = connection?.allowedTools.length ?? 0;
      return allowed === 0
        ? "Ready, no tools allowed"
        : `Ready, ${allowed} ${allowed === 1 ? "tool" : "tools"} allowed`;
    }
  }
}

export const SERVICE_START_FAILURE =
  "It did not start. Check the token and that this machine has Node.js with npx on its path, then try again.";
