/**
 * webPreferences override applied to every preview `<webview>` element via
 * its `webpreferences="..."` attribute. Single source of truth so all guest
 * surfaces inherit the same security posture.
 *
 * Lives in its own electron-free module so the value is unit-testable
 * without importing `Manager.ts` (which transitively imports
 * `electron` and blows up under vitest).
 *
 * - `contextIsolation=true`: the picker preload holds `ipcRenderer`, so it
 *   runs in its own JavaScript world and page scripts cannot reach it or
 *   tamper with the built-ins it uses. The React lookup that must see the
 *   page's own objects runs in the page's world (`PageWorld.ts`).
 * - `sandbox=true`: keeps the OS-level renderer sandbox enabled, so the
 *   preload has no Node globals either.
 * - `nodeIntegration=false`: pinned for clarity (the page itself never gets
 *   Node access).
 *
 * Format notes (locked down by `WebviewPreferences.test.ts`):
 * - Whitespace-free. Electron's webpreferences parser splits on `,` and
 *   does not trim, so a leading space would turn a key into an unknown one
 *   and silently drop it.
 * - Values are JS-boolean strings (`true`/`false`) — `yes`/`no` are not
 *   special-cased by the parser; `value="no"` becomes the truthy STRING
 *   `"no"` when assigned to a boolean webPreferences key.
 *
 * Defense in depth: `DesktopWindow.ts` also runs a `will-attach-webview`
 * handler that force-sets these flags on the actual webPreferences object,
 * gated on the preview partition, so even if this string is ever wrong, the
 * security-critical flags can't regress on preview tabs.
 */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=true,sandbox=true,nodeIntegration=false";
