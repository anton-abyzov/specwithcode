// @effect-diagnostics nodeBuiltinImport:off - Lays the umbrella fixture out in a temp folder.
/**
 * The committed umbrella fixture (`fixtures/umbrella`, every file ending in
 * `.fixture` so tooling leaves it alone) laid out in a new temp folder with
 * the suffix dropped: a workspace root with `repositories/acme/<repo>`
 * checkouts (a UI kit, a status site with a copy of its tokens, an app and a
 * duplicate checkout of it) and `tools/snap`, another copy of the tokens.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const FIXTURE = NodePath.join(import.meta.dirname, "fixtures", "umbrella");

export const UIKIT = "repositories/acme/uikit";
export const UIKIT_TOKENS = `${UIKIT}/src/styles/tokens.css`;
export const UIKIT_BARREL = `${UIKIT}/src/primitives/index.ts`;
export const STATUS_COPY = "repositories/acme/status-site/public/brand/uikit-tokens.css";
export const SNAP_COPY = "tools/snap/static/tokens.css";
export const APP_STYLES = "repositories/acme/app-web/src/app/globals.css";
export const APP_DUPLICATE_STYLES = "repositories/acme/app-web-1015/src/app/globals.css";
/** Files in the fixture: the root's own 3, uikit 6, status site 3, each app checkout 2. */
export const UMBRELLA_FILES = 16;

/** Returns the new folder; the caller removes it. */
export const layOutUmbrella = async (): Promise<string> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "design-umbrella-"));
  const copy = async (relative: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(NodePath.join(FIXTURE, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await NodeFSP.mkdir(NodePath.join(root, path), { recursive: true });
        await copy(path);
      } else if (entry.name.endsWith(".fixture")) {
        await NodeFSP.copyFile(
          NodePath.join(FIXTURE, path),
          NodePath.join(root, path.slice(0, -".fixture".length)),
        );
      }
    }
  };
  await copy("");
  return root;
};
