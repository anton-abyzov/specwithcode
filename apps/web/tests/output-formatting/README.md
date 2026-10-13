# Output formatting verification

Imports real Markdown, error banner, failure detail and reset countdown components into an isolated page. No provider session, account or live runtime is used.

Build from the repository root with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/output-formatting/vite.config.ts`, then run `node scripts/studio-verify/output-formatting.mjs /absolute/evidence-directory`. Use the isolated supported toolchain. Browser launch is explicitly headless; screenshots and receipt are saved to disk.

Covers New York date rollover, 12/24-hour preferences, light/dark at desktop and phone widths, formatted prose/list/table dates, unmodified literal/URL/source content, numbered and nested lists, column semantics and numeric alignment, page overflow, and raw-value CSV copying.
