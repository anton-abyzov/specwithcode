# Inline shell code run verification

Renders the real chat Markdown and inline Run UI on an isolated page. The terminal, scope and machine lookups that `InlineShellRun.tsx` reads are replaced by an in-memory terminal (`stubs.ts`), so no server, store or shell is involved.

Build from the repository root with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/shell-code-run/vite.config.ts`, then run `node scripts/studio-verify/shell-code-run.mjs /absolute/evidence-directory`. The browser launches headless; screenshots and `receipt.json` are saved to disk.

Covers the unlabeled coordinator command from the report shown as bash, word-only wrapping at phone width (no word box spans two lines, `-d` is one word), Full access running on click with output and exit code, Supervised asking before it runs, escape codes removed from output, a device sign-in showing its one-time code to copy and its page as a link while it runs, and Stop ending a running command with exit 130, in light and dark.
