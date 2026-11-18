import type { NativeTool } from "@specweave-studio/contracts";

import type { ServerDraft } from "./serverPaste";

/**
 * A server the app knows how to add. An entry is an address a user will hand
 * their account to, so each one is checked against the vendor's own page and
 * carries that page and the date; one that fails the check is dropped.
 */
export interface CatalogEntry {
  /** The name it is added under. */
  readonly id: string;
  readonly title: string;
  /** One line on the card: what it is for and how sign-in works. */
  readonly line: string;
  /** What it gives an agent, under the summary's title. */
  readonly about: string;
  readonly url: string;
  /** "browser": the tool opens a sign-in page. "token": a key goes in a header. */
  readonly signIn: "browser" | "token" | "none";
  readonly signInText: string;
  /** The header a token goes in, and what the summary calls the field. */
  readonly token?: { readonly header: string; readonly prefix: string; readonly label: string };
  /** A plan, seat or account limit the vendor states. */
  readonly plan?: string;
  /** Set when the vendor admits only some tools: the ones ticked to start. */
  readonly tools?: ReadonlyArray<NativeTool>;
  /** The vendor page the entry was checked against, and the day (YYYY-MM-DD). */
  readonly page: string;
  readonly checked: string;
}

const BROWSER = "In the browser, after you add it. No key to paste.";

export const SERVER_CATALOG: ReadonlyArray<CatalogEntry> = [
  {
    id: "higgsfield",
    title: "Higgsfield",
    line: "Images and video. Browser sign-in.",
    about: "Images and video from your agents.",
    url: "https://mcp.higgsfield.ai/mcp",
    signIn: "browser",
    signInText: BROWSER,
    page: "https://higgsfield.ai/mcp",
    checked: "2026-11-18",
  },
  {
    id: "github",
    title: "GitHub",
    line: "Issues, pull requests, code search. Needs an access token.",
    about: "Issues, pull requests and code search on GitHub.",
    url: "https://api.githubcopilot.com/mcp/",
    signIn: "token",
    signInText: "With a GitHub personal access token, which you paste here.",
    token: { header: "Authorization", prefix: "Bearer ", label: "Personal access token" },
    plan: "Works with every GitHub plan. A few of its tools need a paid Copilot plan.",
    page: "https://github.com/github/github-mcp-server",
    checked: "2026-11-18",
  },
  {
    id: "linear",
    title: "Linear",
    line: "Issues and projects. Browser sign-in.",
    about: "Issues, projects and comments in Linear.",
    url: "https://mcp.linear.app/mcp",
    signIn: "browser",
    signInText: BROWSER,
    page: "https://linear.app/docs/mcp",
    checked: "2026-11-18",
  },
  {
    id: "notion",
    title: "Notion",
    line: "Pages and databases. Browser sign-in.",
    about: "Pages, databases and comments in Notion.",
    url: "https://mcp.notion.com/mcp",
    signIn: "browser",
    signInText: BROWSER,
    plan: "Works on every Notion plan. Workspace guests cannot connect.",
    page: "https://developers.notion.com/docs/get-started-with-mcp",
    checked: "2026-11-18",
  },
  {
    id: "sentry",
    title: "Sentry",
    line: "Errors and traces. Browser sign-in.",
    about: "Errors, traces and releases in Sentry.",
    url: "https://mcp.sentry.dev/mcp",
    signIn: "browser",
    signInText: BROWSER,
    page: "https://mcp.sentry.dev/",
    checked: "2026-11-18",
  },
  {
    id: "context7",
    title: "Context7",
    line: "Current library docs. No sign-in.",
    about: "Up-to-date documentation for the libraries your code uses.",
    url: "https://mcp.context7.com/mcp",
    signIn: "none",
    signInText: "None needed.",
    page: "https://github.com/upstash/context7",
    checked: "2026-11-18",
  },
  {
    id: "figma",
    title: "Figma",
    line: "Designs and components. Browser sign-in.",
    about: "Designs, components and variables from your Figma files.",
    url: "https://mcp.figma.com/mcp",
    signIn: "browser",
    signInText: BROWSER,
    plan: "Figma lets only the AI tools on its own list connect, and limits calls by seat: View and Collab seats get up to 20 a month.",
    tools: ["codex", "claude"],
    page: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    checked: "2026-11-18",
  },
];

/** How many entries show before "Show all". */
export const CATALOG_SHOWN = 6;

/** The server an entry adds. A token entry leaves the token for the user to fill. */
export function catalogDraft(entry: CatalogEntry): ServerDraft {
  return {
    name: entry.id,
    kind: "http",
    server: {
      url: entry.url,
      ...(entry.token ? { headers: { [entry.token.header]: entry.token.prefix } } : {}),
    },
  };
}
