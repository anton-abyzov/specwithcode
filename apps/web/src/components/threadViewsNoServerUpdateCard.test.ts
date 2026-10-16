// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * Server updates show once, in the sidebar footer. Thread and chat views
 * (ChatView, the composer and everything under components/chat) must never
 * render a server-update card again: on a busy machine it sat above every
 * thread's composer with "Copy update steps".
 */
const components = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const THREAD_VIEW_FILES = [
  "ChatView.tsx",
  "ThreadRouteView.tsx",
  "studio/ProjectWorkerPane.tsx",
  ...NodeFS.readdirSync(NodePath.join(components, "chat"))
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    // The status line itself is shared with the sidebar row; it renders no card.
    .filter((name) => name !== "ComposerServerUpdateStatus.tsx")
    .map((name) => `chat/${name}`),
].filter((file) => NodeFS.existsSync(NodePath.join(components, file)));

const FORBIDDEN = [
  /from "[^"]*ServerUpdateAction"/,
  /from "[^"]*ComposerServerUpdateStatus"/,
  /from "[^"]*useAutoBalanceUpdateBanner"/,
  /Server update available/,
  /Copy update steps/,
  /server-version:/,
];

describe("thread views", () => {
  it("covers the thread view entry points", () => {
    expect(THREAD_VIEW_FILES).toContain("ChatView.tsx");
    expect(THREAD_VIEW_FILES.length).toBeGreaterThan(5);
  });

  it.each(THREAD_VIEW_FILES)("%s renders no server-update card", (file) => {
    const source = NodeFS.readFileSync(NodePath.join(components, file), "utf8");
    for (const pattern of FORBIDDEN) {
      expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});
