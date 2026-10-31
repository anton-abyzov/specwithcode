// Stand-ins for what needs a server, a router or a browser tab.
const SHOT = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#f4f1fb"/><rect x="0" y="0" width="320" height="26" fill="#6d4fd1"/><rect x="16" y="44" width="140" height="12" rx="4" fill="#2b2540"/><rect x="16" y="66" width="250" height="8" rx="4" fill="#b9b2cc"/><rect x="16" y="82" width="210" height="8" rx="4" fill="#b9b2cc"/><rect x="16" y="108" width="128" height="72" rx="8" fill="#ffffff" stroke="#ddd6ee"/><rect x="160" y="108" width="128" height="72" rx="8" fill="#ffffff" stroke="#ddd6ee"/></svg>`,
)}`;

export function useAssetUrlState(_environmentId: unknown, resource: unknown) {
  return resource === null ? { _tag: "Initial" } : { _tag: "Success", url: SHOT };
}
export function useOpenLink() {
  return async () => undefined;
}
export function LibraryFileViewer() {
  return null;
}
export function useRouter() {
  return { navigate: async () => undefined };
}
// Fictional file contents for the document page previews.
const FILES: Record<string, string> = {
  ".specweave/increments/1148-shelf/reports/review.md": [
    "# Review of the artifacts shelf",
    "",
    "Ten findings, all **fixed**. The shelf reads thread snapshots again when one is written.",
    "",
    "## Verdict",
    "",
    "- Ship it after green CI.",
    "- Pins stay on this device.",
  ].join("\n"),
  ".specweave/reports/threads/connect-sign-in-report.html": `<!doctype html><html><body style="margin:0;font:15px system-ui;color:#1f1b2e"><div style="background:#6d4fd1;color:#fff;padding:18px 24px;font:600 22px system-ui">Connect sign-in report</div><div style="padding:20px 24px"><p style="margin:0 0 12px">Linked sign-in works on all three machines.</p><div style="display:flex;gap:12px"><div style="flex:1;height:90px;border-radius:10px;background:#eee9fb"></div><div style="flex:1;height:90px;border-radius:10px;background:#e6f5ec"></div></div><script>document.body.style.background="red"</script></div></body></html>`,
};
export function useProjectFileQuery(_env: unknown, _cwd: string, path: string | null) {
  const contents = path === null ? undefined : FILES[path];
  return { data: contents === undefined ? null : { contents, truncated: false } };
}
