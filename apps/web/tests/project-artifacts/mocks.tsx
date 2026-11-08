// Stand-ins for what needs a server, a router or a browser tab.
const SHOT = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#f4f1fb"/><rect x="0" y="0" width="320" height="26" fill="#6d4fd1"/><rect x="16" y="44" width="140" height="12" rx="4" fill="#2b2540"/><rect x="16" y="66" width="250" height="8" rx="4" fill="#b9b2cc"/><rect x="16" y="82" width="210" height="8" rx="4" fill="#b9b2cc"/><rect x="16" y="108" width="128" height="72" rx="8" fill="#ffffff" stroke="#ddd6ee"/><rect x="160" y="108" width="128" height="72" rx="8" fill="#ffffff" stroke="#ddd6ee"/></svg>`,
)}`;

// bench.mjs serves real files here; every other run stays fictional.
const BENCH = new URLSearchParams(location.search).has("bench");
const benchFile = (path: string) => `/bench/file?path=${encodeURIComponent(path)}`;

export function useAssetUrlState(_environmentId: unknown, resource: { path?: string } | null) {
  if (resource === null) return { _tag: "Initial" };
  return { _tag: "Success", url: BENCH && resource.path ? benchFile(resource.path) : SHOT };
}
export function useAssetUrlRefresh(_environmentId: unknown, resource: { path?: string } | null) {
  return async () =>
    resource === null ? null : BENCH && resource.path ? benchFile(resource.path) : SHOT;
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
  ".specweave/increments/0007-bot/reports/task-T-04.txt":
    "$ cd trading-agent && uv run python -m trading_agent.run\n# exit 0 — 2026-10-30T17:40:00.000Z\n\nbacktest done: final equity 9988.44\n",
  ".specweave/increments/0007-bot/reports/task-T-03.txt":
    "$ cd trading-agent && uv run python -m trading_agent.run\n# exit 0 — 2026-10-30T17:40:00.000Z\n\nSKIP: no_momentum\n",
  ".specweave/increments/0007-bot/reports/task-T-02.txt":
    "$ cd trading-agent && uv run python -m trading_agent.run\n# exit 0 — 2026-10-30T17:40:00.000Z\n\n8 passed in 0.04s\n",
  ".specweave/increments/1140-pricing/reports/metrics.json": `{
  "page": "pricing",
  "visitors": 18204,
  "signups": 612,
  "conversion": 0.0336
}`,
  ".specweave/increments/1148-shelf/reports/review.md": [
    "---",
    "date: 2026-10-30",
    "status: passed",
    "---",
    "",
    "# Review of the artifacts shelf",
    "",
    "<!-- generated -->",
    "",
    "Ten findings, all **fixed**.\u0001\f\u001b The shelf reads thread snapshots again when one is written, so a report a thread just made shows without a reload.",
    "",
    "## Verdict",
    "",
    "- Ship it after green CI.",
    "- Pins stay on this device. \ud83d",
    "",
    "| Check | Result |",
    "| --- | --- |",
    "| Unit | Passed |",
    "| Headless | Passed |",
    "",
    "![tracker](https://example.com/md-tracker.png)",
  ].join("\n"),
  ".specweave/reports/threads/connect-sign-in-report.html": `<!doctype html><html><body style="margin:0;font:15px system-ui;color:#1f1b2e"><div style="background:#6d4fd1;color:#fff;padding:18px 24px;font:600 22px system-ui">Connect sign-in report</div><div style="padding:20px 24px"><p style="margin:0 0 12px">Linked sign-in works on all three machines.</p><div style="display:flex;gap:12px"><div style="flex:1;height:90px;border-radius:10px;background:#eee9fb"></div><div style="flex:1;height:90px;border-radius:10px;background:#e6f5ec"></div></div><img src="https://example.com/tracker.png" /><script>document.body.style.background="red"</script></div></body></html>`,
};
export function useProjectFileReader() {
  return async (_env: unknown, _cwd: string, path: string) => {
    if (BENCH) return { _tag: "contents", contents: await (await fetch(benchFile(path))).text() };
    const contents = FILES[path];
    return contents === undefined ? { _tag: "gone" } : { _tag: "contents", contents };
  };
}
